// actuator.js — исполнитель решений политики.
//
// Применяет действия к локальному медиа и к RTCRtpSender:
//   - LADDER → applyConstraints() на VIDEO MediaStreamTrack (resolution, fps)
//   - LADDER → setParameters() с maxBitrate у video RTCRtpSender (bitrate cap)
//   - audioOnly → отключение video sender'а / track.enabled = false
//   - restoreVideo → enabled = true и старт с нижней ступени ladder

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
    if (vs && vs.track) {
      try {
        await vs.track.applyConstraints({
          width:     { ideal: cfg.width },
          height:    { ideal: cfg.height },
          frameRate: { ideal: cfg.fps }
        });
      } catch (e) { console.warn('[actuator] applyConstraints failed', e); }
      try {
        const params = vs.getParameters();
        if (!params.encodings || !params.encodings.length) params.encodings = [{}];
        params.encodings[0].maxBitrate = cfg.maxBitrateKbps * 1000;
        params.encodings[0].maxFramerate = cfg.fps;
        await vs.setParameters(params);
      } catch (e) { console.warn('[actuator] setParameters failed', e); }
    }
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
    if (vs && vs.track) {
      vs.track.enabled = true;
      try {
        const params = vs.getParameters();
        if (params.encodings && params.encodings[0]) params.encodings[0].active = true;
        await vs.setParameters(params);
      } catch {}
    }
    await this._applyLevel(level);
  }
}
