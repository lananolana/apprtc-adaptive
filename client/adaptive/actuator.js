// actuator.js — исполнитель решений политики с поддержкой двусторонней
// кооперативной адаптации.
//
// Каждое решение локальной политики обновляет this.localLevel — желаемый
// уровень качества на основании СВОИХ условий сети.
// При получении сообщения 'remote-constraint' от собеседника обновляется
// this.remoteLevel — максимальный уровень, который собеседник готов
// принимать от нас (исходя из ЕГО условий сети).
// Фактически применяемый уровень = MIN(localLevel, remoteLevel).
//
// Это позволяет реализовать кооперативную адаптацию: если у собеседника
// плохая сеть, он сообщает нам ограничение, и мы автоматически снижаем
// исходящее качество, не дожидаясь, пока ЕГО downlink-канал «продавится»
// и GCC через RTCP-обратную связь придёт к тому же результату.
//
//   - LADDER → setParameters() с scaleResolutionDownBy + maxFramerate + maxBitrate.
//     MediaStreamTrack.applyConstraints не используется, чтобы не вызывать
//     перезахват камеры (видимое «мигание»).
//   - audioOnly (level=-1) → track.enabled=false + encodings[0].active=false.
//   - restoreVideo (level=0) → track.enabled=true + _applyLevel(0).

import { LADDER, AUDIO_ONLY_LEVEL } from './policy.js';

const TOP_LEVEL = LADDER.length - 1;

export class Actuator {
  /** @param {RTCPeerConnection} pc */
  constructor(pc) {
    this.pc = pc;
    // Уровни ступени, запрашиваемые двумя независимыми сторонами.
    // localLevel: что наша локальная политика хочет применить (по нашим
    //   условиям сети).
    // remoteLevel: какой максимум собеседник готов принимать (по ЕГО
    //   условиям сети, получено через 'remote-constraint').
    // Применяется MIN(localLevel, remoteLevel) к нашему отправителю.
    this.localLevel  = TOP_LEVEL;
    this.remoteLevel = TOP_LEVEL;
    this.appliedLevel = TOP_LEVEL;
    // последнее применённое состояние audio-only (чтобы понимать, надо
    // ли явно включить трек обратно при выходе)
    this.audioOnlyApplied = false;
  }

  videoSender() {
    return this.pc.getSenders().find(s => s.track && s.track.kind === 'video');
  }
  audioSender() {
    return this.pc.getSenders().find(s => s.track && s.track.kind === 'audio');
  }

  /**
   * Применить решение локальной политики.
   * Обновляет localLevel и применяет MIN(local, remote).
   */
  async apply(decision) {
    if (!decision) return;
    switch (decision.action) {
      case 'downgrade':
      case 'upgrade':
        this.localLevel = decision.targetLevel;
        break;
      case 'audioOnly':
        this.localLevel = AUDIO_ONLY_LEVEL;
        break;
      case 'restoreVideo':
        this.localLevel = decision.targetLevel; // обычно 0
        break;
    }
    await this._applyEffective();
  }

  /**
   * Обновить «ограничение от собеседника».
   * Если собеседник передал, что у него тяжёлый канал и он не принимает
   * выше уровня N, то наш исходящий поток ограничивается этим уровнем.
   */
  async setRemoteLevel(level) {
    if (typeof level !== 'number') return;
    // Защита от мусора в сообщении
    if (level !== AUDIO_ONLY_LEVEL && (level < 0 || level >= LADDER.length)) return;
    this.remoteLevel = level;
    await this._applyEffective();
  }

  /**
   * Возвращает фактический уровень с учётом обоих ограничений.
   *
   * Принципиальный момент: удалённое ограничение НЕ может загнать нас
   * в режим audio-only. Решение «полностью отключить видео» — это всегда
   * прерогатива ЛОКАЛЬНОЙ политики (на основе наших собственных условий
   * канала). Удалённый сигнал ограничивает только МАКСИМАЛЬНОЕ качество
   * исходящего потока — самая низкая ступень шкалы (level 0, 180p@10
   * с очень узкой полосой ~150 кбит/с) совместима даже с edge-каналами.
   *
   * Это даёт правильный UX: даже если у собеседника узкий канал, мы шлём
   * ему видеопоток самого низкого качества, а не полную тьму. Симметричный
   * audio-only возникает только если ОБА пира независимо решают идти в
   * audio-only по своим локальным условиям.
   */
  effectiveLevel() {
    const remoteAdjusted = this.remoteLevel === AUDIO_ONLY_LEVEL ? 0 : this.remoteLevel;
    return Math.min(this.localLevel, remoteAdjusted);
  }

  /** Внутренний: применить вычисленный MIN-уровень. */
  async _applyEffective() {
    const eff = this.effectiveLevel();
    if (eff === this.appliedLevel) return; // ничего не изменилось
    this.appliedLevel = eff;
    if (eff === AUDIO_ONLY_LEVEL) {
      await this._goAudioOnly();
    } else {
      // если мы были в audio-only — восстанавливаем track перед сменой уровня
      if (this.audioOnlyApplied) {
        const vs = this.videoSender();
        if (vs && vs.track) vs.track.enabled = true;
        this.audioOnlyApplied = false;
      }
      await this._applyLevel(eff);
    }
  }

  async _applyLevel(level) {
    const cfg = LADDER[level];
    if (!cfg) return;
    const vs = this.videoSender();
    if (!vs || !vs.track) return;

    // Защитная мера от утечки качества. _applyLevel вызывается ТОЛЬКО для
    // не-audio-only ступеней — значит видео-трек должен быть включён.
    // Если он отключён, это «осиротевшее» состояние от прошлой сессии,
    // например: были в audio-only → peer вышел → пересоздался pc, но
    // localStream сохранил track.enabled=false. Без этой проверки видео
    // тихо не отправлялось бы при стабильной сети, пока политика не
    // приняла бы первое решение (а она может и не приниматься).
    if (vs.track.enabled === false) vs.track.enabled = true;

    // Разрешение, FPS и битрейт — через setParameters; applyConstraints на
    // MediaStreamTrack не вызываем, чтобы не было перезахвата камеры.
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
      // приоритет плавности над разрешением
      params.degradationPreference = 'maintain-framerate';
      await vs.setParameters(params);
    } catch (e) { console.warn('[actuator] setParameters failed', e); }
  }

  async _goAudioOnly() {
    const vs = this.videoSender();
    if (!vs || !vs.track) return;
    vs.track.enabled = false;
    this.audioOnlyApplied = true;
    try {
      const params = vs.getParameters();
      if (!params.encodings || !params.encodings.length) params.encodings = [{}];
      params.encodings[0].active = false;
      await vs.setParameters(params);
    } catch {}
  }
}
