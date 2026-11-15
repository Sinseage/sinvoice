/**
 * SINVoice — демонстрация экрана: захват и сжатие (WebCodecs) у показывающего, распаковка и вывод у зрителя.
 *
 * Кадр по сети: [3, флаги (бит 0 — ключевой), метка времени мс UInt32 LE, данные кадра].
 *
 * @author Дмитрий Собенин (Sinseage)
 */
'use strict';

/** Пресеты качества. */
const SCREEN_PRESETS = {
  '720p30': { width: 1280, height: 720, fps: 30, bitrate: 2500000 },
  '1080p30': { width: 1920, height: 1080, fps: 30, bitrate: 4500000 },
  '1080p60': { width: 1920, height: 1080, fps: 60, bitrate: 7000000 },
};

const SCREEN_CODECS = ['avc1.640034', 'avc1.4D0034', 'avc1.42E034', 'vp8'];
const KEYFRAME_EVERY_MS = 10000;
const T_SCREEN = 3;

/**
 * Размер под пресет с сохранением пропорций, кратный 2.
 * @param {number} w Ширина источника
 * @param {number} h Высота источника
 * @param {{width:number, height:number}} max Предел
 * @returns {{width:number, height:number}}
 */
function fitSize(w, h, max) {
  const k = Math.min(1, max.width / w, max.height / h);
  return { width: Math.max(2, Math.round((w * k) / 2) * 2), height: Math.max(2, Math.round((h * k) / 2) * 2) };
}

/**
 * Захват экрана и отправка сжатых кадров.
 */
class ScreenSender {
  /**
   * @param {{send:(frame:Uint8Array, key:boolean) => boolean, busy:() => boolean, onStop:() => void, onError:(text:string) => void}} hooks
   *   send — отправить кадр (false, если не получилось), busy — сеть не успевает, onStop — захват завершён, onError — ошибка
   */
  constructor(hooks) {
    this.hooks = hooks;
    this.stream = null;
    this.reader = null;
    this.encoder = null;
    this.codec = '';
    this.preset = SCREEN_PRESETS['1080p30'];
    this.size = null;
    this.forceKey = true;
    this.lastKeyAt = 0;
    this.lastFrameAt = 0;
    this.running = false;
  }

  /**
   * Подбирает кодек, который умеет сжимать этот компьютер.
   * @returns {Promise<string>}
   */
  async pickCodec() {
    for (const codec of SCREEN_CODECS) {
      const config = this.config(codec, { width: this.preset.width, height: this.preset.height });
      try {
        const res = await VideoEncoder.isConfigSupported(config);
        if (res.supported) return codec;
      } catch (e) {
        /* следующий кодек */
      }
    }
    return '';
  }

  /**
   * Настройки кодировщика.
   * @param {string} codec Кодек
   * @param {{width:number, height:number}} size Размер
   * @returns {VideoEncoderConfig}
   */
  config(codec, size) {
    const cfg = {
      codec,
      width: size.width,
      height: size.height,
      bitrate: this.preset.bitrate,
      framerate: this.preset.fps,
      latencyMode: 'realtime',
      hardwareAcceleration: 'no-preference',
    };
    if (codec.startsWith('avc1')) cfg.avc = { format: 'annexb' };
    return cfg;
  }

  /**
   * Начинает показ выбранного источника (источник уже выбран в главном процессе).
   * @param {string} presetName Пресет качества
   * @returns {Promise<string>} Кодек
   */
  async start(presetName) {
    if (typeof VideoEncoder === 'undefined' || typeof MediaStreamTrackProcessor === 'undefined') {
      throw new Error('Система не поддерживает сжатие видео');
    }
    this.preset = SCREEN_PRESETS[presetName] || SCREEN_PRESETS['1080p30'];
    this.codec = await this.pickCodec();
    if (!this.codec) throw new Error('Не найден подходящий видеокодек');
    this.stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: this.preset.fps, max: this.preset.fps } },
      audio: false,
    });
    const track = this.stream.getVideoTracks()[0];
    track.contentHint = this.preset.fps >= 60 ? 'motion' : 'detail';
    track.addEventListener('ended', () => this.stop());

    this.encoder = new VideoEncoder({
      output: (chunk) => this.onChunk(chunk),
      error: (err) => {
        this.hooks.onError(`Ошибка сжатия видео: ${err && err.message ? err.message : err}`);
        this.stop();
      },
    });
    this.size = null;
    this.forceKey = true;
    this.running = true;
    this.reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
    this.pump();
    return this.codec;
  }

  /**
   * Читает кадры захвата, прореживает до нужной частоты и отдаёт кодировщику.
   */
  async pump() {
    const minGap = 1000 / this.preset.fps - 2;
    while (this.running) {
      let res;
      try { res = await this.reader.read(); } catch (e) { break; }
      if (res.done) break;
      const frame = res.value;
      const now = performance.now();
      if (!this.running || now - this.lastFrameAt < minGap || this.encoder.encodeQueueSize > 2 || this.hooks.busy()) {
        frame.close();
        continue;
      }
      this.lastFrameAt = now;
      const size = fitSize(frame.displayWidth, frame.displayHeight, this.preset);
      if (!this.size || size.width !== this.size.width || size.height !== this.size.height) {
        this.size = size;
        this.encoder.configure(this.config(this.codec, size));
        this.forceKey = true;
      }
      const key = this.forceKey || now - this.lastKeyAt > KEYFRAME_EVERY_MS;
      if (key) {
        this.forceKey = false;
        this.lastKeyAt = now;
      }
      try {
        this.encoder.encode(frame, { keyFrame: key });
      } finally {
        frame.close();
      }
    }
    if (this.running) this.stop();
  }

  /**
   * Сжатый кадр готов — упаковывает и отправляет.
   * @param {EncodedVideoChunk} chunk Кадр
   */
  onChunk(chunk) {
    if (!this.running) return;
    const key = chunk.type === 'key';
    const out = new Uint8Array(6 + chunk.byteLength);
    out[0] = T_SCREEN;
    out[1] = key ? 1 : 0;
    new DataView(out.buffer).setUint32(2, Math.floor(chunk.timestamp / 1000) >>> 0, true);
    chunk.copyTo(out.subarray(6));
    if (!this.hooks.send(out, key)) this.forceKey = true;
  }

  /**
   * Следующий кадр сделать ключевым (новый зритель или потеря кадров).
   */
  requestKeyframe() {
    this.forceKey = true;
  }

  /**
   * Останавливает захват.
   */
  stop() {
    if (!this.running && !this.stream) return;
    this.running = false;
    if (this.reader) this.reader.cancel().catch(() => {});
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    if (this.encoder && this.encoder.state !== 'closed') {
      try { this.encoder.close(); } catch (e) { /* уже закрыт */ }
    }
    this.reader = null;
    this.stream = null;
    this.encoder = null;
    this.hooks.onStop();
  }
}

/**
 * Приём и вывод экрана участника на canvas.
 */
class ScreenViewer {
  /**
   * @param {HTMLCanvasElement} canvas Холст
   * @param {() => void} onNeedKey Попросить ключевой кадр
   */
  constructor(canvas, onNeedKey) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.onNeedKey = onNeedKey;
    this.decoder = null;
    this.codec = '';
    this.waitKey = true;
  }

  /**
   * Готовит распаковщик под кодек показывающего.
   * @param {string} codec Кодек
   * @returns {Promise<void>}
   */
  async open(codec) {
    this.close();
    if (typeof VideoDecoder === 'undefined') throw new Error('Система не поддерживает видео');
    const res = await VideoDecoder.isConfigSupported({ codec, optimizeForLatency: true });
    if (!res.supported) throw new Error(`Кодек ${codec} не поддерживается`);
    this.codec = codec;
    this.create();
  }

  /**
   * Создаёт распаковщик заново (после ошибки).
   */
  create() {
    this.decoder = new VideoDecoder({
      output: (frame) => this.draw(frame),
      error: () => {
        this.waitKey = true;
        this.onNeedKey();
        if (this.codec) setTimeout(() => this.codec && this.create(), 0);
      },
    });
    this.decoder.configure({ codec: this.codec, optimizeForLatency: true });
    this.waitKey = true;
  }

  /**
   * Принимает кадр из сети.
   * @param {boolean} key Ключевой
   * @param {number} ts Метка времени, мс
   * @param {Uint8Array} data Данные
   */
  push(key, ts, data) {
    if (!this.decoder || this.decoder.state !== 'configured') return;
    if (this.waitKey && !key) return;
    if (this.decoder.decodeQueueSize > 8) {
      this.waitKey = true;
      this.onNeedKey();
      return;
    }
    this.waitKey = false;
    try {
      this.decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: ts * 1000, data }));
    } catch (e) {
      this.waitKey = true;
      this.onNeedKey();
    }
  }

  /**
   * Рисует кадр.
   * @param {VideoFrame} frame Кадр
   */
  draw(frame) {
    try {
      if (this.canvas.width !== frame.displayWidth || this.canvas.height !== frame.displayHeight) {
        this.canvas.width = frame.displayWidth;
        this.canvas.height = frame.displayHeight;
      }
      this.ctx.drawImage(frame, 0, 0);
    } finally {
      frame.close();
    }
  }

  /**
   * Закрывает распаковщик и очищает холст.
   */
  close() {
    this.codec = '';
    if (this.decoder && this.decoder.state !== 'closed') {
      try { this.decoder.close(); } catch (e) { /* уже закрыт */ }
    }
    this.decoder = null;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }
}

window.ScreenSender = ScreenSender;
window.ScreenViewer = ScreenViewer;
window.SCREEN_PRESETS = SCREEN_PRESETS;
