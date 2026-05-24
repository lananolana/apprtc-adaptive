// collector.js — периодический сбор RTCStatsReport с одного RTCPeerConnection.
//
// Полностью клиентский слой наблюдаемости (см. отчёт о практике, §2.2).
// Извлекаем только нужные нам интегральные показатели, чтобы дальнейшие
// модули (aggregator/policy) работали с компактной структурой, а не с
// сырым RTCStatsReport, у которого вендорные различия в схеме.
//
// Возвращаемая «сырая» запись:
//   {
//     ts:       number (ms, performance.now),
//     rttMs:    number | null,
//     jitterMs: number | null,
//     packetsLost: number | null,   // абсолютное
//     packetsReceived: number | null,
//     videoBitsPerSec: number | null,
//     audioBitsPerSec: number | null,
//     fps:      number | null,
//     frameWidth:  number | null,
//     frameHeight: number | null,
//     framesDropped: number | null,
//   }

let prev = null;

function pickPair(report) {
  for (const r of report.values()) {
    if (r.type === 'candidate-pair' && r.state === 'succeeded' && (r.nominated || r.selected)) return r;
  }
  // fallback — any candidate-pair with non-null currentRoundTripTime
  for (const r of report.values()) {
    if (r.type === 'candidate-pair' && r.currentRoundTripTime != null) return r;
  }
  return null;
}

function pickOutbound(report, kind) {
  for (const r of report.values()) {
    if (r.type === 'outbound-rtp' && r.kind === kind) return r;
  }
  return null;
}

function pickInbound(report, kind) {
  for (const r of report.values()) {
    if (r.type === 'inbound-rtp' && r.kind === kind) return r;
  }
  return null;
}

function rate(curr, prev, key, dtSec) {
  if (!prev || curr[key] == null || prev[key] == null || dtSec <= 0) return null;
  const d = curr[key] - prev[key];
  return d >= 0 ? d / dtSec : null;
}

async function sample(pc) {
  const report = await pc.getStats();
  const now = performance.now();
  const dtSec = prev ? (now - prev.ts) / 1000 : 0;

  const pair  = pickPair(report);
  const outV  = pickOutbound(report, 'video');
  const outA  = pickOutbound(report, 'audio');
  const inV   = pickInbound(report, 'video');

  const out = {
    ts: now,
    rttMs:    pair?.currentRoundTripTime != null ? pair.currentRoundTripTime * 1000 : null,
    jitterMs: inV?.jitter != null ? inV.jitter * 1000 : null,
    packetsLost: inV?.packetsLost ?? null,
    packetsReceived: inV?.packetsReceived ?? null,
    videoBitsPerSec: null,
    audioBitsPerSec: null,
    fps: outV?.framesPerSecond ?? null,
    frameWidth:  outV?.frameWidth ?? null,
    frameHeight: outV?.frameHeight ?? null,
    framesDropped: outV?.framesEncoded != null && outV?.framesSent != null
      ? outV.framesEncoded - outV.framesSent
      : null,
  };

  if (prev && outV && prev.outV) {
    const bytes = rate({ b: outV.bytesSent }, { b: prev.outV.bytesSent }, 'b', dtSec);
    if (bytes != null) out.videoBitsPerSec = bytes * 8;
  }
  if (prev && outA && prev.outA) {
    const bytes = rate({ b: outA.bytesSent }, { b: prev.outA.bytesSent }, 'b', dtSec);
    if (bytes != null) out.audioBitsPerSec = bytes * 8;
  }

  prev = { ts: now, outV, outA };
  return out;
}

/**
 * @param {RTCPeerConnection} pc
 * @param {(rawSample: object) => void} onSample
 * @param {{ intervalMs?: number }} [opts]
 */
export function startMetricsCollector(pc, onSample, opts = {}) {
  const intervalMs = opts.intervalMs ?? 1000;
  let stopped = false;
  prev = null;

  const tick = async () => {
    if (stopped) return;
    try {
      const s = await sample(pc);
      onSample(s);
    } catch (e) {
      console.warn('[collector] sample failed', e);
    }
  };

  const id = setInterval(tick, intervalMs);
  tick();

  return {
    stop() { stopped = true; clearInterval(id); }
  };
}
