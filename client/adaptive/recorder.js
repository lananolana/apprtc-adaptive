// recorder.js — запись телеметрии WebRTC-сессии в CSV для экспериментов.
//
// Один сеанс записи накапливает строки в памяти и сбрасывает в файл по
// команде «Стоп». Формат CSV: одна строка в секунду, столбцы фиксированы.
// Дополнительные колонки `mode`, `event` помогают сегментировать сессию
// при сравнении baseline vs adaptive и при смене сетевых профилей.

const COLUMNS = [
  'ts_ms', 'mode', 'event',
  'rttMs', 'jitterMs', 'lossPct',
  'videoKbps', 'audioKbps',
  'fps', 'frameWidth', 'frameHeight',
  'framesDropped', 'qoeScore',
  'adaptAction', 'adaptLevel',
  // Входящие кумулятивные счётчики — нужны для расширенных метрик
  // анализа (число замираний, доля «полезного» видеосигнала на приёме).
  'inboundVideoFramesReceived',
  'inboundVideoBytesReceived',
  'inboundAudioBytesReceived',
];

function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export class Recorder {
  constructor() {
    this.rows = [];
    this.startedAt = null;
    this.lastDecision = null;
    this.currentEvent = '';
  }

  isActive() { return this.startedAt != null; }

  start() {
    this.rows = [];
    this.startedAt = performance.now();
    this.currentEvent = 'start';
  }

  stop() {
    if (!this.isActive()) return null;
    const csv = this.toCsv();
    this.startedAt = null;
    return csv;
  }

  /** Пометить переход на новый сетевой профиль или режим */
  mark(eventLabel) {
    this.currentEvent = String(eventLabel || '');
  }

  /** Подхватить последнее решение политики, чтобы лог содержал adaptation state */
  noteDecision(decision) {
    this.lastDecision = decision || null;
  }

  /** Записать один сэмпл (вызывается из основного цикла телеметрии) */
  record(stats, mode) {
    if (!this.isActive()) return;
    const row = {
      ts_ms: Math.round(performance.now() - this.startedAt),
      mode: mode || '',
      event: this.currentEvent,
      rttMs: stats.rttMs != null ? Math.round(stats.rttMs) : '',
      jitterMs: stats.jitterMs != null ? +stats.jitterMs.toFixed(2) : '',
      lossPct: stats.lossPct != null ? +stats.lossPct.toFixed(2) : '',
      videoKbps: stats.videoKbps != null ? Math.round(stats.videoKbps) : '',
      audioKbps: stats.audioKbps != null ? Math.round(stats.audioKbps) : '',
      fps: stats.fps != null ? +stats.fps.toFixed(1) : '',
      frameWidth: stats.frameWidth ?? '',
      frameHeight: stats.frameHeight ?? '',
      framesDropped: stats.framesDropped ?? '',
      qoeScore: stats.qoeScore ?? '',
      adaptAction: this.lastDecision?.action ?? '',
      adaptLevel: this.lastDecision?.targetLevel ?? '',
      inboundVideoFramesReceived: stats.inboundVideoFramesReceived ?? '',
      inboundVideoBytesReceived:  stats.inboundVideoBytesReceived  ?? '',
      inboundAudioBytesReceived:  stats.inboundAudioBytesReceived  ?? '',
    };
    this.rows.push(row);
    // event «вспышечный»: проявляется один раз после mark(), далее — пусто
    this.currentEvent = '';
  }

  toCsv() {
    const header = COLUMNS.join(',');
    const body = this.rows.map(r => COLUMNS.map(c => csvEscape(r[c])).join(',')).join('\n');
    return `${header}\n${body}\n`;
  }

  /** Скачать как файл */
  download(filename) {
    const csv = this.toCsv();
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename || `webrtc-run-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
  }
}
