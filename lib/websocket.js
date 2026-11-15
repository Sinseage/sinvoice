/**
 * SINVoice — минимальный WebSocket-сервер (RFC 6455) на встроенных модулях Node.js.
 *
 * Поддерживает текстовые и двоичные сообщения, фрагментацию, ping/pong и закрытие.
 * Расширения (сжатие) и подпротоколы не поддерживаются.
 *
 * @author Дмитрий Собенин (Sinseage)
 */
'use strict';

const http = require('http');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xA;

const OPEN = 1;
const CLOSED = 3;

const PING_INTERVAL = 20000;
const IDLE_TIMEOUT = 60000;

/**
 * Собирает кадр сервер → клиент (без маски).
 * @param {number} opcode Код операции
 * @param {Buffer} payload Данные
 * @returns {Buffer}
 */
function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.allocUnsafe(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload], header.length + len);
}

/**
 * Готовит сообщение к отправке один раз — для рассылки многим получателям.
 * @param {string|Buffer|Uint8Array} data Сообщение
 * @returns {Buffer} Готовый кадр
 */
function encodeMessage(data) {
  if (typeof data === 'string') return encodeFrame(OP_TEXT, Buffer.from(data, 'utf8'));
  return encodeFrame(OP_BINARY, Buffer.isBuffer(data) ? data : Buffer.from(data));
}

/**
 * Одно WebSocket-соединение.
 * События: `message` (data: Buffer, isBinary: boolean), `close` (code: number).
 */
class WsConnection extends EventEmitter {
  /**
   * @param {import('net').Socket} socket Сокет после рукопожатия
   * @param {string} remoteAddress Адрес клиента
   * @param {number} maxPayload Наибольший размер сообщения в байтах
   */
  constructor(socket, remoteAddress, maxPayload) {
    super();
    this.socket = socket;
    this.remoteAddress = remoteAddress;
    this.maxPayload = maxPayload;
    this.readyState = OPEN;
    this.chunks = [];
    this.buffered = 0;
    this.fragments = [];
    this.fragmentsLen = 0;
    this.fragmentOp = 0;
    this.need = 0;
    this.lastSeen = Date.now();

    socket.setNoDelay(true);
    socket.on('data', (d) => this.onData(d));
    socket.on('close', () => this.finish(1006));
    socket.on('error', () => this.finish(1006));
    this.pingTimer = setInterval(() => this.keepAlive(), PING_INTERVAL);
  }

  /**
   * Объём данных, ещё не ушедших в сеть.
   * @returns {number}
   */
  get bufferedAmount() {
    return this.socket.writableLength;
  }

  /**
   * Отправляет сообщение.
   * @param {string|Buffer|Uint8Array} data Текст или двоичные данные
   */
  send(data) {
    this.sendRaw(encodeMessage(data));
  }

  /**
   * Отправляет заранее собранный кадр.
   * @param {Buffer} frame Кадр из encodeMessage
   */
  sendRaw(frame) {
    if (this.readyState !== OPEN) return;
    this.socket.write(frame);
  }

  /**
   * Закрывает соединение с кодом.
   * @param {number} [code] Код закрытия
   * @param {string} [reason] Причина
   */
  close(code = 1000, reason = '') {
    if (this.readyState !== OPEN) return;
    const r = Buffer.from(String(reason).slice(0, 100), 'utf8');
    const payload = Buffer.allocUnsafe(2 + r.length);
    payload.writeUInt16BE(code, 0);
    r.copy(payload, 2);
    this.socket.write(encodeFrame(OP_CLOSE, payload));
    this.socket.end();
    setTimeout(() => this.socket.destroy(), 2000).unref();
    this.finish(code);
  }

  /**
   * Немедленно рвёт соединение.
   */
  terminate() {
    this.socket.destroy();
    this.finish(1006);
  }

  /**
   * Пинг и обрыв молчащего соединения.
   */
  keepAlive() {
    if (Date.now() - this.lastSeen > IDLE_TIMEOUT) {
      this.terminate();
      return;
    }
    if (this.readyState === OPEN) this.socket.write(encodeFrame(OP_PING, Buffer.alloc(0)));
  }

  /**
   * Освобождает ресурсы и сообщает о закрытии один раз.
   * @param {number} code Код закрытия
   */
  finish(code) {
    if (this.readyState === CLOSED) return;
    this.readyState = CLOSED;
    clearInterval(this.pingTimer);
    this.chunks = [];
    this.fragments = [];
    this.emit('close', code);
  }

  /**
   * Копит входящие байты и разбирает готовые кадры.
   * @param {Buffer} data Порция из сокета
   */
  onData(data) {
    if (this.readyState !== OPEN) return;
    this.lastSeen = Date.now();
    this.chunks.push(data);
    this.buffered += data.length;
    if (this.buffered < this.need) return;
    let buf = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.buffered);
    let offset = 0;
    while (this.readyState === OPEN) {
      const used = this.parseFrame(buf, offset);
      if (used === 0) break;
      offset += used;
    }
    if (this.readyState !== OPEN) return;
    buf = offset < buf.length ? buf.subarray(offset) : null;
    this.chunks = buf ? [buf] : [];
    this.buffered = buf ? buf.length : 0;
  }

  /**
   * Разбирает один кадр.
   * @param {Buffer} buf Буфер
   * @param {number} start Начало кадра
   * @returns {number} Сколько байт занял кадр, 0 — кадр ещё не пришёл целиком
   */
  parseFrame(buf, start) {
    if (buf.length - start < 2) return 0;
    const b0 = buf[start];
    const b1 = buf[start + 1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    if (b0 & 0x70) { this.close(1002, 'rsv'); return 0; }
    if (!(b1 & 0x80)) { this.close(1002, 'mask'); return 0; }
    let len = b1 & 0x7f;
    let pos = start + 2;
    if (len === 126) {
      if (buf.length - pos < 2) return 0;
      len = buf.readUInt16BE(pos);
      pos += 2;
    } else if (len === 127) {
      if (buf.length - pos < 8) return 0;
      const big = buf.readBigUInt64BE(pos);
      if (big > BigInt(this.maxPayload)) { this.close(1009, 'too big'); return 0; }
      len = Number(big);
      pos += 8;
    }
    if (len > this.maxPayload) { this.close(1009, 'too big'); return 0; }
    if (buf.length - pos < 4 + len) {
      this.need = pos + 4 + len - start;
      return 0;
    }
    this.need = 0;
    const mask = buf.subarray(pos, pos + 4);
    pos += 4;
    const payload = Buffer.allocUnsafe(len);
    for (let i = 0; i < len; i++) payload[i] = buf[pos + i] ^ mask[i & 3];
    this.onFrame(fin, opcode, payload);
    return pos + len - start;
  }

  /**
   * Обрабатывает разобранный кадр.
   * @param {boolean} fin Последний фрагмент
   * @param {number} opcode Код операции
   * @param {Buffer} payload Данные
   */
  onFrame(fin, opcode, payload) {
    switch (opcode) {
      case OP_PING:
        if (payload.length <= 125) this.socket.write(encodeFrame(OP_PONG, payload));
        return;
      case OP_PONG:
        return;
      case OP_CLOSE:
        this.close(payload.length >= 2 ? payload.readUInt16BE(0) : 1000);
        return;
      case OP_TEXT:
      case OP_BINARY:
        if (this.fragmentOp) { this.close(1002, 'fragment'); return; }
        if (fin) { this.emit('message', payload, opcode === OP_BINARY); return; }
        this.fragmentOp = opcode;
        this.fragments = [payload];
        this.fragmentsLen = payload.length;
        return;
      case OP_CONT:
        if (!this.fragmentOp) { this.close(1002, 'continuation'); return; }
        this.fragmentsLen += payload.length;
        if (this.fragmentsLen > this.maxPayload) { this.close(1009, 'too big'); return; }
        this.fragments.push(payload);
        if (fin) {
          const whole = Buffer.concat(this.fragments, this.fragmentsLen);
          const binary = this.fragmentOp === OP_BINARY;
          this.fragments = [];
          this.fragmentsLen = 0;
          this.fragmentOp = 0;
          this.emit('message', whole, binary);
        }
        return;
      default:
        this.close(1002, 'opcode');
    }
  }
}

/**
 * HTTP-сервер, принимающий только WebSocket-подключения.
 * События: `connection` (conn: WsConnection), `error` (err).
 */
class WsServer extends EventEmitter {
  /**
   * @param {{maxPayload:number, accept?:(ip:string) => boolean}} opts Лимит сообщения и фильтр адресов до рукопожатия
   */
  constructor(opts) {
    super();
    this.maxPayload = opts.maxPayload;
    this.accept = opts.accept || (() => true);
    this.http = http.createServer((req, res) => {
      res.writeHead(426, { 'Content-Type': 'text/plain' });
      res.end('SINVoice');
    });
    this.http.headersTimeout = 10000;
    this.http.requestTimeout = 10000;
    this.http.on('upgrade', (req, socket) => this.onUpgrade(req, socket));
    this.http.on('clientError', (_err, socket) => socket.destroy());
    this.http.on('error', (err) => this.emit('error', err));
  }

  /**
   * Начинает слушать порт на всех адресах.
   * @param {number} port Порт
   * @returns {Promise<void>}
   */
  listen(port) {
    return new Promise((resolve, reject) => {
      const onError = (err) => reject(err);
      this.http.once('error', onError);
      this.http.listen(port, () => {
        this.http.off('error', onError);
        resolve();
      });
    });
  }

  /**
   * Перестаёт принимать подключения.
   * @returns {Promise<void>}
   */
  close() {
    return new Promise((resolve) => this.http.close(() => resolve()));
  }

  /**
   * Рукопожатие WebSocket.
   * @param {import('http').IncomingMessage} req Запрос
   * @param {import('net').Socket} socket Сокет
   */
  onUpgrade(req, socket) {
    const ip = normalizeIp(req.socket.remoteAddress || '');
    const key = req.headers['sec-websocket-key'];
    const ok = req.method === 'GET'
      && String(req.headers.upgrade || '').toLowerCase() === 'websocket'
      && req.headers['sec-websocket-version'] === '13'
      && typeof key === 'string'
      && /^[A-Za-z0-9+/]{22}==$/.test(key);
    if (!ok) {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      return;
    }
    if (!this.accept(ip)) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      return;
    }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    this.emit('connection', new WsConnection(socket, ip, this.maxPayload));
  }
}

/**
 * Приводит IPv4-адрес в виде IPv6 (::ffff:1.2.3.4) к обычному.
 * @param {string} ip Адрес
 * @returns {string}
 */
function normalizeIp(ip) {
  return ip.startsWith('::ffff:') ? ip.slice(7) : ip;
}

module.exports = { WsServer, WsConnection, encodeMessage, OPEN };
