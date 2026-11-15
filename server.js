/**
 * SINVoice — сервер комнаты.
 *
 * Ретранслирует голос, чат и файлы между участниками. Ничего не сохраняет:
 * сообщения и куски файлов пересылаются только тем, кто подключён в момент отправки.
 *
 * Двоичные кадры клиент → сервер:
 *   [0]=1 голос, [1]=0, [2..] PCM Int16 LE
 *   [0]=2 файл,  [1]=0, [2..5] fid (UInt32 LE), [6..] данные
 * Сервер → клиент: тот же тип, [2..3] id отправителя (UInt16 LE), далее как выше
 * (для голоса PCM начинается с байта 4, для файла fid в [4..7], данные с 8).
 *
 * @author Дмитрий Собенин (Sinseage)
 */
'use strict';

const { WebSocketServer } = require('ws');

const MAX_CLIENTS = 16;
const MAX_AVATAR_LEN = 300000;
const MAX_CHAT_LEN = 2000;
const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024;
const AUDIO_DROP_BUFFER = 512 * 1024;
const FILE_BUFFER_LIMIT = 2 * 1024 * 1024;

const T_AUDIO = 1;
const T_FILE = 2;

class RoomServer {
  /**
   * @param {{port:number, password?:string}} opts Параметры сервера
   */
  constructor(opts) {
    this.port = opts.port;
    this.password = opts.password || '';
    /** @type {Map<number, {ws:any, id:number, nick:string, avatar:string, muted:boolean, deafened:boolean, files:Map<number, Set<number>>}>} */
    this.clients = new Map();
    this.nextId = 1;
    this.wss = null;
    this.ackTimer = null;
  }

  /**
   * Запускает сервер.
   * @returns {Promise<void>}
   */
  start() {
    return new Promise((resolve, reject) => {
      this.wss = new WebSocketServer({ port: this.port, maxPayload: 1024 * 1024 });
      this.wss.once('listening', () => resolve());
      this.wss.once('error', (err) => reject(err));
      this.wss.on('connection', (ws) => this.onConnection(ws));
      this.ackTimer = setInterval(() => this.tickAcks(), 50);
    });
  }

  /**
   * Останавливает сервер и отключает всех.
   * @returns {Promise<void>}
   */
  stop() {
    return new Promise((resolve) => {
      clearInterval(this.ackTimer);
      if (!this.wss) return resolve();
      for (const c of this.clients.values()) {
        try { c.ws.close(4000, 'server stopped'); } catch (e) { /* уже закрыт */ }
      }
      this.clients.clear();
      this.wss.close(() => resolve());
      this.wss = null;
    });
  }

  /**
   * Обрабатывает новое подключение.
   * @param {any} ws Сокет
   */
  onConnection(ws) {
    let client = null;
    const helloTimer = setTimeout(() => ws.close(4001, 'no hello'), 10000);

    ws.on('message', (data, isBinary) => {
      if (!client) {
        if (isBinary) return;
        let msg;
        try { msg = JSON.parse(data.toString()); } catch (e) { return; }
        if (msg.t !== 'hello') return;
        clearTimeout(helloTimer);
        client = this.register(ws, msg);
        return;
      }
      if (isBinary) this.onBinary(client, data);
      else this.onJson(client, data.toString());
    });

    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (client) {
        this.clients.delete(client.id);
        this.broadcast({ t: 'leave', id: client.id });
      }
    });
    ws.on('error', () => { /* закрытие обработает close */ });
  }

  /**
   * Регистрирует участника после приветствия.
   * @param {any} ws Сокет
   * @param {object} msg Сообщение hello
   * @returns {object|null} Участник
   */
  register(ws, msg) {
    if (this.password && msg.password !== this.password) {
      this.send(ws, { t: 'error', code: 'password', text: 'Неверный пароль комнаты' });
      ws.close(4003, 'password');
      return null;
    }
    if (this.clients.size >= MAX_CLIENTS) {
      this.send(ws, { t: 'error', code: 'full', text: 'Комната заполнена' });
      ws.close(4004, 'full');
      return null;
    }
    const client = {
      ws,
      id: this.nextId++,
      nick: String(msg.nick || 'Гость').slice(0, 32),
      avatar: typeof msg.avatar === 'string' && msg.avatar.length < MAX_AVATAR_LEN && msg.avatar.startsWith('data:image/') ? msg.avatar : '',
      muted: !!msg.muted,
      deafened: !!msg.deafened,
      files: new Map(),
      pendingAcks: new Map(),
    };
    this.clients.set(client.id, client);
    this.send(ws, { t: 'welcome', id: client.id, peers: [...this.clients.values()].map(publicInfo) });
    this.broadcast({ t: 'join', peer: publicInfo(client) }, client.id);
    return client;
  }

  /**
   * Обрабатывает JSON-сообщение участника.
   * @param {object} client Участник
   * @param {string} text Текст сообщения
   */
  onJson(client, text) {
    let msg;
    try { msg = JSON.parse(text); } catch (e) { return; }
    switch (msg.t) {
      case 'ping':
        this.send(client.ws, { t: 'pong', ts: msg.ts });
        break;
      case 'state':
        client.muted = !!msg.muted;
        client.deafened = !!msg.deafened;
        this.broadcast({ t: 'state', id: client.id, muted: client.muted, deafened: client.deafened }, client.id);
        break;
      case 'profile':
        client.nick = String(msg.nick || client.nick).slice(0, 32);
        if (typeof msg.avatar === 'string' && msg.avatar.length < MAX_AVATAR_LEN && (msg.avatar === '' || msg.avatar.startsWith('data:image/'))) {
          client.avatar = msg.avatar;
        }
        this.broadcast({ t: 'profile', peer: publicInfo(client) }, client.id);
        break;
      case 'chat': {
        const body = String(msg.text || '').slice(0, MAX_CHAT_LEN).trim();
        if (body) this.broadcast({ t: 'chat', id: client.id, text: body, ts: Date.now() });
        break;
      }
      case 'file-offer': {
        const fid = msg.fid >>> 0;
        const size = Number(msg.size) || 0;
        if (!fid || size <= 0 || size > MAX_FILE_SIZE || client.files.has(fid)) return;
        const recipients = new Set([...this.clients.keys()].filter((id) => id !== client.id));
        client.files.set(fid, recipients);
        const offer = { t: 'file-offer', id: client.id, fid, name: String(msg.name || 'file').slice(0, 255), size, ts: Date.now() };
        for (const id of recipients) this.sendTo(id, offer);
        break;
      }
      case 'file-end':
      case 'file-cancel': {
        const fid = msg.fid >>> 0;
        const recipients = client.files.get(fid);
        if (!recipients) return;
        client.files.delete(fid);
        client.pendingAcks.delete(fid);
        for (const id of recipients) this.sendTo(id, { t: msg.t, id: client.id, fid });
        break;
      }
      default:
        break;
    }
  }

  /**
   * Ретранслирует двоичный кадр (голос или кусок файла).
   * @param {object} client Отправитель
   * @param {Buffer} data Кадр
   */
  onBinary(client, data) {
    if (data.length < 2) return;
    const type = data[0];
    if (type === T_AUDIO) {
      if (client.muted || data.length < 4 || (data.length - 2) % 2 !== 0) return;
      const out = Buffer.allocUnsafe(data.length + 2);
      out[0] = T_AUDIO; out[1] = 0;
      out.writeUInt16LE(client.id, 2);
      data.copy(out, 4, 2);
      for (const c of this.clients.values()) {
        if (c.id === client.id || c.deafened) continue;
        if (c.ws.bufferedAmount > AUDIO_DROP_BUFFER) continue;
        c.ws.send(out, { binary: true });
      }
    } else if (type === T_FILE) {
      if (data.length < 7) return;
      const fid = data.readUInt32LE(2);
      const recipients = client.files.get(fid);
      if (!recipients) return;
      const out = Buffer.allocUnsafe(data.length + 2);
      out[0] = T_FILE; out[1] = 0;
      out.writeUInt16LE(client.id, 2);
      data.copy(out, 4, 2);
      for (const id of recipients) {
        const c = this.clients.get(id);
        if (c) c.ws.send(out, { binary: true });
      }
      client.pendingAcks.set(fid, (client.pendingAcks.get(fid) || 0) + 1);
      this.flushAcks(client);
    }
  }

  /**
   * Подтверждает отправителю приём кусков файла, если получатели успевают.
   * Так файл не копится в памяти сервера, а отправитель идёт со скоростью самого медленного получателя.
   * @param {object} client Отправитель
   */
  flushAcks(client) {
    for (const [fid, n] of client.pendingAcks) {
      const recipients = client.files.get(fid);
      let busy = false;
      if (recipients) {
        for (const id of recipients) {
          const c = this.clients.get(id);
          if (c && c.ws.bufferedAmount > FILE_BUFFER_LIMIT) { busy = true; break; }
        }
      }
      if (busy) continue;
      client.pendingAcks.delete(fid);
      this.send(client.ws, { t: 'file-ack', fid, n });
    }
  }

  /**
   * Периодически проверяет отложенные подтверждения.
   */
  tickAcks() {
    for (const c of this.clients.values()) {
      if (c.pendingAcks.size) this.flushAcks(c);
    }
  }

  /**
   * @param {any} ws Сокет
   * @param {object} obj Сообщение
   */
  send(ws, obj) {
    if (ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  /**
   * @param {number} id Id участника
   * @param {object} obj Сообщение
   */
  sendTo(id, obj) {
    const c = this.clients.get(id);
    if (c) this.send(c.ws, obj);
  }

  /**
   * Рассылает сообщение всем, кроме указанного.
   * @param {object} obj Сообщение
   * @param {number} [exceptId] Кого пропустить
   */
  broadcast(obj, exceptId) {
    const text = JSON.stringify(obj);
    for (const c of this.clients.values()) {
      if (c.id !== exceptId && c.ws.readyState === 1) c.ws.send(text);
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
