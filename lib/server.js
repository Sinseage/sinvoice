/**
 * SINVoice — сервер комнаты.
 *
 * Ретранслирует голос, чат и файлы между участниками и ничего не сохраняет:
 * сообщения и куски файлов уходят только тем, кто подключён в момент отправки.
 *
 * Двоичные кадры клиент → сервер:
 *   [0]=1 голос, [1]=0, [2..] PCM Int16 LE, ровно 480 сэмплов
 *   [0]=2 файл,  [1]=0, [2..5] fid (UInt32 LE), [6..] данные
 * Сервер → клиент: тот же тип, [2..3] id отправителя (UInt16 LE), далее как у клиента со сдвигом на 2 байта.
 *
 * @author Дмитрий Собенин (Sinseage)
 */
'use strict';

const crypto = require('crypto');
const { WsServer, encodeMessage, OPEN } = require('./websocket');

const MAX_CLIENTS = 16;
const MAX_PER_IP = 4;
const MAX_PENDING = 32;
const HELLO_TIMEOUT = 10000;
const AUTH_FAILS = 5;
const AUTH_BLOCK_MS = 5 * 60 * 1000;
const MAX_PAYLOAD = 512 * 1024;
const MAX_AVATAR_LEN = 200000;
const MAX_CHAT_LEN = 2000;
const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024;
const MAX_FILE_CHUNK = 64 * 1024;
const MAX_ACTIVE_FILES = 4;
const MAX_UNACKED = 48;
const AUDIO_BYTES = 960;
const AUDIO_DROP_BUFFER = 512 * 1024;
const FILE_BUFFER_LIMIT = 2 * 1024 * 1024;
const MAX_VIOLATIONS = 200;

const T_AUDIO = 1;
const T_FILE = 2;

const AVATAR_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

/**
 * Ограничитель частоты «ведро с жетонами».
 */
class Bucket {
  /**
   * @param {number} rate Жетонов в секунду
   * @param {number} burst Ёмкость
   */
  constructor(rate, burst) {
    this.rate = rate;
    this.burst = burst;
    this.tokens = burst;
    this.ts = Date.now();
  }

  /**
   * Пытается взять жетон.
   * @returns {boolean} Разрешено ли действие
   */
  take() {
    const now = Date.now();
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.ts) / 1000) * this.rate);
    this.ts = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

/**
 * Очищает ник: без управляющих символов, без лишних пробелов, до 32 символов.
 * @param {*} value Исходное значение
 * @returns {string}
 */
function cleanNick(value) {
  const s = String(value || '').replace(/[\p{C}]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 32);
  return s || 'Гость';
}

/**
 * Проверяет аватар: только PNG, JPEG или WebP в base64 разумного размера.
 * @param {*} value Исходное значение
 * @returns {string} Аватар или пустая строка
 */
function cleanAvatar(value) {
  return typeof value === 'string' && value.length < MAX_AVATAR_LEN && AVATAR_RE.test(value) ? value : '';
}

/**
 * Хеш пароля для сравнения за постоянное время.
 * @param {string} s Пароль
 * @returns {Buffer}
 */
function digest(s) {
  return crypto.createHash('sha256').update(String(s || ''), 'utf8').digest();
}

class RoomServer {
  /**
   * @param {{port:number, password?:string, logger:{info:Function, warn:Function, error:Function}}} opts Параметры
   */
  constructor(opts) {
    this.port = opts.port;
    this.passwordHash = opts.password ? digest(opts.password) : null;
    this.log = opts.logger;
    /** @type {Map<number, object>} */
    this.clients = new Map();
    /** @type {Map<string, number>} */
    this.perIp = new Map();
    /** @type {Map<string, {count:number, until:number, last:number}>} */
    this.fails = new Map();
    this.pending = 0;
    this.nextId = 1;
    this.ws = null;
    this.ackTimer = null;
  }

  /**
   * Запускает сервер.
   * @returns {Promise<void>}
   */
  async start() {
    this.ws = new WsServer({ maxPayload: MAX_PAYLOAD, accept: (ip) => this.canAccept(ip) });
    this.ws.on('connection', (conn) => this.onConnection(conn));
    this.ws.on('error', (err) => this.log.error(`Сервер: ${err && err.message}`));
    await this.ws.listen(this.port);
    this.ackTimer = setInterval(() => this.safe(() => this.tickAcks()), 50);
    this.log.info(`Сервер запущен на порту ${this.port}`);
  }

  /**
   * Останавливает сервер и отключает всех.
   * @returns {Promise<void>}
   */
  async stop() {
    clearInterval(this.ackTimer);
    for (const c of this.clients.values()) c.conn.close(4000, 'server stopped');
    this.clients.clear();
    if (this.ws) await this.ws.close();
    this.ws = null;
    this.log.info('Сервер остановлен');
  }

  /**
   * Выполняет обработчик, не давая ошибке уронить процесс.
   * @param {Function} fn Обработчик
   */
  safe(fn) {
    try {
      fn();
    } catch (err) {
      this.log.error(`Сервер: ${err && err.stack ? err.stack : err}`);
    }
  }

  /**
   * Можно ли принять подключение с адреса (до рукопожатия).
   * @param {string} ip Адрес
   * @returns {boolean}
   */
  canAccept(ip) {
    return this.pending < MAX_PENDING && (this.perIp.get(ip) || 0) < MAX_PER_IP;
  }

  /**
   * Новое подключение.
   * @param {import('./websocket').WsConnection} conn Соединение
   */
  onConnection(conn) {
    const ip = conn.remoteAddress;
    this.perIp.set(ip, (this.perIp.get(ip) || 0) + 1);
    this.pending++;
    let client = null;
    let pending = true;
    const leavePending = () => {
      if (pending) { pending = false; this.pending--; }
    };
    const helloTimer = setTimeout(() => conn.close(4001, 'no hello'), HELLO_TIMEOUT);

    conn.on('message', (data, isBinary) => this.safe(() => {
      if (client) {
        if (isBinary) this.onBinary(client, data); else this.onJson(client, data);
        return;
      }
      if (isBinary || data.length > MAX_AVATAR_LEN + 4096) { conn.close(4002, 'bad hello'); return; }
      let msg;
      try { msg = JSON.parse(data.toString('utf8')); } catch (e) { conn.close(4002, 'bad hello'); return; }
      if (!msg || msg.t !== 'hello') { conn.close(4002, 'bad hello'); return; }
      clearTimeout(helloTimer);
      leavePending();
      client = this.register(conn, msg);
    }));

    conn.on('close', () => this.safe(() => {
      clearTimeout(helloTimer);
      leavePending();
      const n = (this.perIp.get(ip) || 1) - 1;
      if (n > 0) this.perIp.set(ip, n); else this.perIp.delete(ip);
      if (client && this.clients.get(client.id) === client) {
        this.clients.delete(client.id);
        for (const c of this.clients.values()) {
          for (const set of c.files.values()) set.recipients.delete(client.id);
        }
        this.broadcast({ t: 'leave', id: client.id });
      }
    }));
  }

  /**
   * Проверяет приветствие и регистрирует участника.
   * @param {import('./websocket').WsConnection} conn Соединение
   * @param {object} msg Сообщение hello
   * @returns {object|null} Участник или null при отказе
   */
  register(conn, msg) {
    const ip = conn.remoteAddress;
    if (this.fails.size > 1000) {
      const now = Date.now();
      for (const [k, v] of this.fails) if (v.until < now && now - v.last > AUTH_BLOCK_MS) this.fails.delete(k);
    }
    const fail = this.fails.get(ip);
    if (fail && fail.until > Date.now()) {
      this.send(conn, { t: 'error', code: 'blocked', text: 'Слишком много неверных паролей. Попробуйте через 5 минут' });
      conn.close(4005, 'blocked');
      return null;
    }
    if (this.passwordHash && !crypto.timingSafeEqual(digest(msg.password), this.passwordHash)) {
      const now = Date.now();
      const f = fail && now - fail.last < AUTH_BLOCK_MS ? fail : { count: 0, until: 0, last: 0 };
      f.count++;
      f.last = now;
      if (f.count >= AUTH_FAILS) {
        f.until = Date.now() + AUTH_BLOCK_MS;
        f.count = 0;
        this.log.warn(`Адрес ${ip} заблокирован на 5 минут: неверный пароль ${AUTH_FAILS} раз`);
      }
      this.fails.set(ip, f);
      this.send(conn, { t: 'error', code: 'password', text: 'Неверный пароль комнаты' });
      conn.close(4003, 'password');
      return null;
    }
    this.fails.delete(ip);
    if (this.clients.size >= MAX_CLIENTS) {
      this.send(conn, { t: 'error', code: 'full', text: 'Комната заполнена' });
      conn.close(4004, 'full');
      return null;
    }
    const client = {
      conn,
      id: this.nextId++,
      nick: cleanNick(msg.nick),
      avatar: cleanAvatar(msg.avatar),
      muted: !!msg.muted,
      deafened: !!msg.deafened,
      files: new Map(),
      json: new Bucket(40, 80),
      chat: new Bucket(1, 5),
      profile: new Bucket(0.5, 3),
      audio: new Bucket(60, 120),
      offers: new Bucket(1, 4),
      violations: 0,
      noticeAt: 0,
    };
    while (this.nextId > 65535 || this.clients.has(this.nextId)) {
      this.nextId = this.nextId > 65535 ? 1 : this.nextId + 1;
    }
    this.clients.set(client.id, client);
    this.send(conn, { t: 'welcome', id: client.id, peers: [...this.clients.values()].map(publicInfo) });
    this.broadcast({ t: 'join', peer: publicInfo(client) }, client.id);
    return client;
  }

  /**
   * Учитывает нарушение лимитов; при злоупотреблении отключает участника.
   * @param {object} client Участник
   * @param {string} [notice] Текст предупреждения
   */
  violation(client, notice) {
    client.violations++;
    if (client.violations > MAX_VIOLATIONS) {
      this.log.warn(`Отключён ${client.conn.remoteAddress}: превышение лимитов`);
      client.conn.close(4006, 'flood');
      return;
    }
    if (notice && Date.now() - client.noticeAt > 3000) {
      client.noticeAt = Date.now();
      this.send(client.conn, { t: 'notice', text: notice });
    }
  }

  /**
   * JSON-сообщение участника.
   * @param {object} client Участник
   * @param {Buffer} data Данные
   */
  onJson(client, data) {
    if (!client.json.take()) { this.violation(client); return; }
    let msg;
    try { msg = JSON.parse(data.toString('utf8')); } catch (e) { this.violation(client); return; }
    if (!msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case 'ping':
        if (Number.isFinite(msg.ts)) this.send(client.conn, { t: 'pong', ts: msg.ts });
        break;
      case 'state':
        client.muted = !!msg.muted;
        client.deafened = !!msg.deafened;
        this.broadcast({ t: 'state', id: client.id, muted: client.muted, deafened: client.deafened }, client.id);
        break;
      case 'profile':
        if (!client.profile.take()) { this.violation(client, 'Профиль меняется слишком часто'); return; }
        client.nick = cleanNick(msg.nick);
        client.avatar = cleanAvatar(msg.avatar);
        this.broadcast({ t: 'profile', peer: publicInfo(client) }, client.id);
        break;
      case 'chat': {
        const text = String(msg.text || '').replace(/[\p{Cc}\p{Cf}]/gu, (ch) => (ch === '\n' ? ch : '')).trim().slice(0, MAX_CHAT_LEN);
        if (!text) return;
        if (!client.chat.take()) { this.violation(client, 'Слишком много сообщений, подождите немного'); return; }
        this.broadcast({ t: 'chat', id: client.id, text, ts: Date.now() });
        break;
      }
      case 'file-offer':
        this.onFileOffer(client, msg);
        break;
      case 'file-end':
      case 'file-cancel':
        this.onFileFinish(client, msg);
        break;
      default:
        this.violation(client);
    }
  }

  /**
   * Начало передачи файла.
   * @param {object} client Отправитель
   * @param {object} msg Сообщение
   */
  onFileOffer(client, msg) {
    const fid = Number(msg.fid) >>> 0;
    const size = Number(msg.size);
    if (!fid || !Number.isSafeInteger(size) || size <= 0 || size > MAX_FILE_SIZE || client.files.has(fid)) {
      this.violation(client);
      return;
    }
    if (client.files.size >= MAX_ACTIVE_FILES || !client.offers.take()) {
      this.send(client.conn, { t: 'file-reject', fid, text: 'Слишком много файлов одновременно' });
      return;
    }
    const name = String(msg.name || 'file').replace(/[\p{C}]/gu, '').slice(0, 255) || 'file';
    const recipients = new Set([...this.clients.keys()].filter((id) => id !== client.id));
    client.files.set(fid, { recipients, size, received: 0, unacked: 0 });
    const offer = encodeMessage(JSON.stringify({ t: 'file-offer', id: client.id, fid, name, size, ts: Date.now() }));
    for (const id of recipients) this.sendRawTo(id, offer);
  }

  /**
   * Конец или отмена передачи файла.
   * @param {object} client Отправитель
   * @param {object} msg Сообщение
   */
  onFileFinish(client, msg) {
    const fid = Number(msg.fid) >>> 0;
    const f = client.files.get(fid);
    if (!f) return;
    client.files.delete(fid);
    const t = msg.t === 'file-end' && f.received === f.size ? 'file-end' : 'file-cancel';
    const frame = encodeMessage(JSON.stringify({ t, id: client.id, fid }));
    for (const id of f.recipients) this.sendRawTo(id, frame);
  }

  /**
   * Двоичный кадр: голос или кусок файла.
   * @param {object} client Отправитель
   * @param {Buffer} data Кадр
   */
  onBinary(client, data) {
    const type = data[0];
    if (type === T_AUDIO) {
      if (data.length !== AUDIO_BYTES + 2) { this.violation(client); return; }
      if (client.muted || !client.audio.take()) return;
      const out = Buffer.allocUnsafe(data.length + 2);
      out[0] = T_AUDIO;
      out[1] = 0;
      out.writeUInt16LE(client.id, 2);
      data.copy(out, 4, 2);
      const frame = encodeMessage(out);
      for (const c of this.clients.values()) {
        if (c.id === client.id || c.deafened || c.conn.bufferedAmount > AUDIO_DROP_BUFFER) continue;
        c.conn.sendRaw(frame);
      }
      return;
    }
    if (type === T_FILE) {
      if (data.length < 7 || data.length > MAX_FILE_CHUNK + 6) { this.violation(client); return; }
      const fid = data.readUInt32LE(2);
      const f = client.files.get(fid);
      if (!f) return;
      f.received += data.length - 6;
      f.unacked++;
      if (f.received > f.size || f.unacked > MAX_UNACKED) {
        this.log.warn(`Отключён ${client.conn.remoteAddress}: нарушение протокола передачи файла`);
        client.conn.close(4007, 'file protocol');
        return;
      }
      const out = Buffer.allocUnsafe(data.length + 2);
      out[0] = T_FILE;
      out[1] = 0;
      out.writeUInt16LE(client.id, 2);
      data.copy(out, 4, 2);
      const frame = encodeMessage(out);
      for (const id of f.recipients) this.sendRawTo(id, frame);
      this.flushAcks(client);
      return;
    }
    this.violation(client);
  }

  /**
   * Подтверждает отправителю приём кусков, когда получатели успевают их забирать.
   * Так файл не копится в памяти сервера, а отправка идёт со скоростью самого медленного получателя.
   * @param {object} client Отправитель
   */
  flushAcks(client) {
    for (const [fid, f] of client.files) {
      if (!f.unacked) continue;
      let busy = false;
      for (const id of f.recipients) {
        const c = this.clients.get(id);
        if (c && c.conn.bufferedAmount > FILE_BUFFER_LIMIT) { busy = true; break; }
      }
      if (busy) continue;
      this.send(client.conn, { t: 'file-ack', fid, n: f.unacked });
      f.unacked = 0;
    }
  }

  /**
   * Периодическая проверка отложенных подтверждений.
   */
  tickAcks() {
    for (const c of this.clients.values()) {
      if (c.files.size) this.flushAcks(c);
    }
  }

  /**
   * @param {import('./websocket').WsConnection} conn Соединение
   * @param {object} obj Сообщение
   */
  send(conn, obj) {
    if (conn.readyState === OPEN) conn.send(JSON.stringify(obj));
  }

  /**
   * @param {number} id Id участника
   * @param {Buffer} frame Готовый кадр
   */
  sendRawTo(id, frame) {
    const c = this.clients.get(id);
    if (c) c.conn.sendRaw(frame);
  }

  /**
   * Рассылает сообщение всем, кроме указанного; кадр собирается один раз.
   * @param {object} obj Сообщение
   * @param {number} [exceptId] Кого пропустить
   */
  broadcast(obj, exceptId) {
    const frame = encodeMessage(JSON.stringify(obj));
    for (const c of this.clients.values()) {
      if (c.id !== exceptId) c.conn.sendRaw(frame);
    }
  }
}

/**
 * Публичные данные участника.
 * @param {object} c Участник
 * @returns {{id:number, nick:string, avatar:string, muted:boolean, deafened:boolean}}
 */
function publicInfo(c) {
  return { id: c.id, nick: c.nick, avatar: c.avatar, muted: c.muted, deafened: c.deafened };
}

module.exports = { RoomServer };
