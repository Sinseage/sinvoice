/**
 * SINVoice — звуковой движок: захват микрофона с шумоподавлением и микширование входящих голосов.
 *
 * Формат передачи: PCM Int16, моно, 24 кГц, кадры по 20 мс (480 сэмплов).
 *
 * @author Дмитрий Собенин (Sinseage)
 */
'use strict';

const SAMPLE_RATE = 24000;
const FRAME = 480;

/**
 * Код процессора захвата: собирает кадры по 20 мс, считает громкость, отдаёт PCM Int16.
 * Загружается через Blob URL, поэтому хранится строкой.
 */
const CAPTURE_WORKLET = `
class SvCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(${FRAME});
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === ${FRAME}) {
        const out = new Int16Array(${FRAME});
        let sum = 0;
        for (let j = 0; j < ${FRAME}; j++) {
          let v = this.buf[j];
          if (v > 1) v = 1; else if (v < -1) v = -1;
          sum += v * v;
          out[j] = v < 0 ? v * 32768 : v * 32767;
        }
        this.port.postMessage({ pcm: out, rms: Math.sqrt(sum / ${FRAME}) }, [out.buffer]);
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor('sv-capture', SvCapture);
`;

/**
 * Код процессора воспроизведения: буфер джиттера на каждого участника и сведение в один канал.
 */
const PLAYER_WORKLET = `
const START = ${FRAME * 3};
const MAX = ${FRAME * 15};
const TARGET = ${FRAME * 5};
class SvPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.q = new Map();
    this.port.onmessage = (e) => {
      const d = e.data;
      if (d.type === 'frame') {
        let p = this.q.get(d.id);
        if (!p) { p = { chunks: [], off: 0, len: 0, started: false }; this.q.set(d.id, p); }
        const src = d.pcm;
        const f = new Float32Array(src.length);
        for (let i = 0; i < src.length; i++) f[i] = src[i] / 32768;
        p.chunks.push(f);
        p.len += f.length;
        if (p.len > MAX) {
          while (p.len > TARGET && p.chunks.length) {
            const c = p.chunks.shift();
            p.len -= c.length - p.off;
            p.off = 0;
          }
        }
      } else if (d.type === 'remove') {
        this.q.delete(d.id);
      } else if (d.type === 'clear') {
        this.q.clear();
      }
    };
  }
  process(_inputs, outputs) {
    const out = outputs[0][0];
    for (const p of this.q.values()) {
      if (!p.started) {
        if (p.len >= START) p.started = true; else continue;
      }
      let i = 0;
      while (i < out.length && p.chunks.length) {
        const c = p.chunks[0];
        const take = Math.min(out.length - i, c.length - p.off);
        for (let k = 0; k < take; k++) out[i + k] += c[p.off + k];
        i += take;
        p.off += take;
        p.len -= take;
        if (p.off >= c.length) { p.chunks.shift(); p.off = 0; }
      }
      if (p.len <= 0) { p.started = false; p.len = 0; }
    }
    for (let i = 0; i < out.length; i++) {
      if (out[i] > 1) out[i] = 1; else if (out[i] < -1) out[i] = -1;
    }
    return true;
  }
}
registerProcessor('sv-player', SvPlayer);
`;

/**
 * Делает Blob URL для кода процессора.
 * @param {string} code Исходный код
 * @returns {string}
 */
function workletUrl(code) {
  return URL.createObjectURL(new Blob([code], { type: 'application/javascript' }));
}

class AudioEngine {
  /**
   * @param {(pcm:Int16Array, rms:number) => void} onFrame Вызывается на каждый кадр с микрофона
   */
  constructor(onFrame) {
    this.onFrame = onFrame;
    this.ctx = null;
    this.stream = null;
    this.source = null;
    this.inGain = null;
    this.capture = null;
    this.player = null;
    this.outGain = null;
    this.sink = null;
    this.running = false;
    this.opts = {};
    this.outputVolume = 1;
    this.deafened = false;
  }

  /**
   * Запускает захват и воспроизведение.
   * @param {{inputId:string, outputId:string, noiseSuppression:boolean, inputGain:number, outputVolume:number}} opts Настройки
   * @returns {Promise<void>}
   */
  async start(opts) {
    if (this.running) await this.stop();
    this.opts = { ...opts };
    this.outputVolume = opts.outputVolume;
    this.ctx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' });
    await this.ctx.audioWorklet.addModule(workletUrl(CAPTURE_WORKLET));
    await this.ctx.audioWorklet.addModule(workletUrl(PLAYER_WORKLET));
    await this.applyOutputDevice(opts.outputId);

    this.player = new AudioWorkletNode(this.ctx, 'sv-player', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
    this.outGain = this.ctx.createGain();
    this.outGain.gain.value = this.deafened ? 0 : this.outputVolume;
    this.player.connect(this.outGain).connect(this.ctx.destination);

    this.capture = new AudioWorkletNode(this.ctx, 'sv-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    this.capture.port.onmessage = (e) => this.onFrame(e.data.pcm, e.data.rms);
    this.sink = this.ctx.createGain();
    this.sink.gain.value = 0;
    this.capture.connect(this.sink).connect(this.ctx.destination);
    this.inGain = this.ctx.createGain();
    this.inGain.gain.value = opts.inputGain;
    this.inGain.connect(this.capture);

    this.running = true;
    await this.openMic();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  /**
   * Открывает микрофон с текущими настройками.
   * @returns {Promise<void>}
   */
  async openMic() {
    this.closeMic();
    const audio = {
      channelCount: 1,
      echoCancellation: true,
      autoGainControl: true,
      noiseSuppression: !!this.opts.noiseSuppression,
    };
    if (this.opts.inputId && this.opts.inputId !== 'default') audio.deviceId = { exact: this.opts.inputId };
    this.stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.source.connect(this.inGain);
  }

  /**
   * Закрывает микрофон.
   */
  closeMic() {
    if (this.source) { try { this.source.disconnect(); } catch (e) { /* уже отключён */ } }
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.source = null;
    this.stream = null;
  }

  /**
   * Меняет микрофон или режим шумоподавления на лету.
   * @param {{inputId?:string, noiseSuppression?:boolean}} opts Новые значения
   * @returns {Promise<void>}
   */
  async updateInput(opts) {
    Object.assign(this.opts, opts);
    if (this.running) await this.openMic();
  }

  /**
   * Выбирает устройство вывода.
   * @param {string} id Id устройства
   * @returns {Promise<void>}
   */
  async applyOutputDevice(id) {
    this.opts.outputId = id;
    if (!this.ctx || typeof this.ctx.setSinkId !== 'function') return;
    try {
      await this.ctx.setSinkId(!id || id === 'default' ? '' : id);
    } catch (e) {
      await this.ctx.setSinkId('');
    }
  }

  /**
   * @param {number} v Усиление микрофона (0..2)
   */
  setInputGain(v) {
    this.opts.inputGain = v;
    if (this.inGain) this.inGain.gain.value = v;
  }

  /**
   * @param {number} v Громкость (0..2)
   */
  setOutputVolume(v) {
    this.outputVolume = v;
    if (this.outGain && !this.deafened) this.outGain.gain.value = v;
  }

  /**
   * Заглушает весь входящий звук.
   * @param {boolean} on Выключить звук
   */
  setDeafened(on) {
    this.deafened = on;
    if (this.outGain) this.outGain.gain.value = on ? 0 : this.outputVolume;
    if (on && this.player) this.player.port.postMessage({ type: 'clear' });
  }

  /**
   * Передаёт кадр участника на воспроизведение.
   * @param {number} id Id участника
   * @param {Int16Array} pcm Кадр
   */
  play(id, pcm) {
    if (!this.player || this.deafened) return;
    this.player.port.postMessage({ type: 'frame', id, pcm });
  }

  /**
   * Убирает буфер ушедшего участника.
   * @param {number} id Id участника
   */
  removePeer(id) {
    if (this.player) this.player.port.postMessage({ type: 'remove', id });
  }

  /**
   * Останавливает всё и освобождает устройства.
   * @returns {Promise<void>}
   */
  async stop() {
    this.running = false;
    this.closeMic();
    if (this.ctx) {
      try { await this.ctx.close(); } catch (e) { /* уже закрыт */ }
    }
    this.ctx = null;
    this.capture = null;
    this.player = null;
    this.inGain = null;
    this.outGain = null;
    this.sink = null;
  }
}

window.AudioEngine = AudioEngine;
