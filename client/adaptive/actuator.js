// actuator.js — исполнитель решений политики.
//
// Применяет действия к локальному медиа и к RTCRtpSender:
//   - LADDER → setParameters() с scaleResolutionDownBy + maxFramerate + maxBitrate.
//     MediaStreamTrack.applyConstraints не используется, чтобы не вызывать
//     перезахват камеры (видимое «мигание»).
//   - audioOnly → track.enabled = false + encodings[0].active = false.
//   - restoreVideo → track.enabled = true + _applyLevel(targetLevel).

import { LADDER, AUDIO_ONLY_LEVEL } from '/adaptive/policy.js';

export class Actuator {
  /** @param {RTCPeerConnection} pc */
  constructor(pc) {
    this.pc = pc;
    this.currentLevel = LADDER.length - 1;
  }

  videoSender() {
    return this.pc.getSenders().find(s => s.track && s.track.kind === 'video');
  }
  audioSender() {
    return this.pc.getSenders().find(s => s.track && s.track.kind === 'audio');
  }

  async apply(decision) {
    if (!decision) return;
    switch (decision.action) {
      case 'downgrade':
      case 'upgrade':
        await this._applyLevel(decision.targetLevel);
        break;
      case 'audioOnly':
        await this._goAudioOnly();
        break;
      case 'restoreVideo':
        await this._restoreVideo(decision.targetLevel);
        break;
    }
    this.currentLevel = decision.targetLevel;
  }

  async _applyLevel(level) {
    const cfg = LADDER[level];
    if (!cfg) return;
    const vs = this.videoSender();
    if (!vs || !vs.track) return;

    // Принципиальный момент: разрешение и FPS меняем ИСКЛЮЧИТЕЛЬНО через
    // RTCRtpSender.setParameters() (scaleResolutionDownBy + maxFramerate),
    // не трогая MediaStreamTrack.applyConstraints. Это позволяет менять
    // качество исходящего видеопотока без перезахвата камеры — иначе при
    // каждой смене ступени происходила бы visible re-negotiation камеры
    // («мигание» индикатора и кадра).

    // Считаем коэффициент даунскейла относительно реального разрешения
    // захвата камеры (берём из getSettings, чтобы корректно работать,
    // если камера выдаёт не ровно 720p).
    const settings = vs.track.getSettings();
    const captureHeight = settings.height || 720;
    const scaleDown = Math.max(1, captureHeight / cfg.height);

    try {
      const params = vs.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      const enc = params.encodings[0];
      enc.scaleResolutionDownBy = scaleDown;
      enc.maxBitrate    = cfg.maxBitrateKbps * 1000;
      enc.maxFramerate  = cfg.fps;
      enc.active        = true;
      await vs.setParameters(params);
    } catch (e) { console.warn('[actuator] setParameters failed', e); }
  }

  async _goAudioOnly() {
    const vs = this.videoSender();
    if (vs && vs.track) {
      vs.track.enabled = false;
      try {
        const params = vs.getParameters();
        if (!params.encodings || !params.encodings.length) params.encodings = [{}];
        params.encodings[0].active = false;
        await vs.setParameters(params);
      } catch {}
    }
  }

  async _restoreVideo(level) {
    const vs = this.videoSender();
    if (vs && vs.track) vs.track.enabled = true;
    // _applyLevel выставит encodings[0].active = true одной операцией
    // setParameters вместе с разрешением, FPS и битрейтом — не нужно
    // дублировать отдельным вызовом.
    await this._applyLevel(level);
  }
}
