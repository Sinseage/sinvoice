/**
 * SINVoice — логика главного окна: подключение, голос, чат, файлы, настройки.
 *
 * Чат и файлы живут только в памяти этого окна и очищаются при выходе из звонка.
 *
 * @author Дмитрий Собенин (Sinseage)
 */
'use strict';

(() => {
  const api = window.sinvoice;
  const $ = (name) => document.querySelector(`[data-sv="${name}"]`);

  const STORE_KEY = 'sinvoice.settings';
  const DEFAULT_PORT = 47800;
  const VAD_HOLD_MS = 350;
  const SPEAK_HOLD_MS = 250;
  const FILE_CHUNK = 64 * 1024;
  const FILE_WINDOW = 16;
  const MAX_FILE = 2 * 1024 * 1024 * 1024;
  const MAX_INCOMING = 2 * 1024 * 1024 * 1024;
  const MAX_MESSAGES = 500;
  const MAX_AVATAR_FILE = 10 * 1024 * 1024;
  const MAX_AVATAR_PX = 8000;
  const AVATAR_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
  const T_AUDIO = 1;
  const T_FILE = 2;
  const T_SCREEN = 3;
  const SCREEN_CODEC_RE = /^(avc1\.[0-9A-Fa-f]{6}|vp8|vp09\.\d{2}\.\d{2}\.\d{2})$/;
  const SCREEN_BUSY_BYTES = 1536 * 1024;

  const DEFAULTS = {
    nick: '',
    avatar: '',
    inputId: 'default',
    outputId: 'default',
    mode: 'vad',
    ptt: null,
    vadThreshold: -50,
    noiseSuppression: true,
    inputGain: 1,
    outputVolume: 1,
    overlay: true,
    theme: 'dark',
    port: DEFAULT_PORT,
    password: '',
    screenQuality: '1080p30',
    linkPreview: true,
    lastIp: '',
  };

  /** Сохранённые настройки. */
  const settings = loadSettings();

  /** Текущее состояние звонка. */
  const st = {
    ws: null,
    connecting: false,
    connected: false,
    leaving: false,
    hosting: false,
    hostPort: 0,
    myId: 0,
    peers: new Map(),
    muted: false,
    deafened: false,
    pttDown: false,
    transmitting: false,
    lastVoice: 0,
    rtt: -1,
    pingTimer: 0,
    view: 'chat',
    capturingKey: false,
    pttAvailable: false,
    outgoing: new Map(),
    incoming: new Map(),
    lastSpeaking: '',
    overlaySig: '',
    chatSeq: 0,
    pendingPreviews: new Map(),
    messagesByMid: new Map(),
    sharing: false,
    watching: 0,
    pickedSource: '',
    update: null,
    level: 0,
  };

  const engine = new window.AudioEngine(onMicFrame);

  const sender = new window.ScreenSender({
    send: (frame) => {
      const ws = st.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > SCREEN_BUSY_BYTES * 2) return false;
      ws.send(frame);
      return true;
    },
    busy: () => !st.ws || st.ws.bufferedAmount > SCREEN_BUSY_BYTES,
    onStop: () => {
      if (st.sharing) send({ t: 'screen-stop' });
      st.sharing = false;
      renderControls();
      renderPeers();
    },
    onError: (text) => addSystem(text),
  });

  const viewer = new window.ScreenViewer($('screenCanvas'), () => {
    if (st.watching) send({ t: 'screen-keyframe', id: st.watching });
  });

  /* ---------- Настройки ---------- */

  /**
   * Загружает настройки из локального хранилища.
   * @returns {object}
   */
  function loadSettings() {
    let raw = {};
    try { raw = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; } catch (e) { raw = {}; }
    const out = { ...DEFAULTS };
    for (const key of Object.keys(DEFAULTS)) {
      if (key in raw && (typeof raw[key] === typeof DEFAULTS[key] || DEFAULTS[key] === null)) out[key] = raw[key];
    }
    out.avatar = typeof out.avatar === 'string' && /^data:image\/(png|jpeg|webp);base64,/.test(out.avatar) ? out.avatar : '';
    out.mode = out.mode === 'ptt' ? 'ptt' : 'vad';
    out.theme = out.theme === 'light' ? 'light' : 'dark';
    out.vadThreshold = Math.min(-10, Math.max(-80, Number(out.vadThreshold) || DEFAULTS.vadThreshold));
    out.inputGain = Math.min(2, Math.max(0, Number(out.inputGain)));
    out.outputVolume = Math.min(2, Math.max(0, Number(out.outputVolume)));
    out.port = out.port >= 1024 && out.port <= 65535 ? Math.floor(out.port) : DEFAULT_PORT;
    if (out.ptt && (typeof out.ptt !== 'object' || !Number.isInteger(out.ptt.code))) out.ptt = null;
    return out;
  }

  /**
   * Сохраняет настройки.
   */
  function saveSettings() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch (e) { /* хранилище недоступно */ }
  }

  /**
   * Ник с запасным значением.
   * @returns {string}
   */
  function myNick() {
    return settings.nick.trim() || 'Гость';
  }

  /* ---------- Утилиты ---------- */

  /**
   * Склонение слова по числу.
   * @param {number} n Число
   * @param {[string,string,string]} forms Формы: 1, 2-4, 5+
   * @returns {string}
   */
  function plural(n, forms) {
    const a = Math.abs(n) % 100;
    const b = a % 10;
    if (a > 10 && a < 20) return forms[2];
    if (b > 1 && b < 5) return forms[1];
    if (b === 1) return forms[0];
    return forms[2];
  }

  /**
   * Размер файла в читаемом виде.
   * @param {number} bytes Байты
   * @returns {string}
   */
  function fmtSize(bytes) {
    const u = ['Б', 'КБ', 'МБ', 'ГБ'];
    let i = 0;
    let v = bytes;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v < 10 && i ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
  }

  /**
   * Время ЧЧ:ММ.
   * @param {number} ts Метка времени
   * @returns {string}
   */
  function fmtTime(ts) {
    const d = new Date(ts);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  /**
   * Создаёт элемент.
   * @param {string} tag Тег
   * @param {string} [cls] Классы
   * @param {string} [text] Текст
   * @returns {HTMLElement}
   */
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  /**
   * Иконка из спрайта.
   * @param {string} name Id символа без префикса
   * @param {string} [cls] Класс
   * @returns {SVGElement}
   */
  function icon(name, cls) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', cls ? `sv-icon ${cls}` : 'sv-icon');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(ns, 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.appendChild(use);
    return svg;
  }

  /**
   * Цвет по строке для аватара-буквы.
   * @param {string} s Строка
   * @returns {string}
   */
  function hue(s) {
    let h = 0;
    for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return `hsl(${h} 55% 48%)`;
  }

  /**
   * Заполняет блок аватара картинкой или первой буквой ника.
   * @param {HTMLElement} slot Блок
   * @param {string} avatar Data URL
   * @param {string} nick Ник
   */
  function fillAvatar(slot, avatar, nick) {
    slot.textContent = '';
    const safe = cleanAvatar(avatar);
    slot.classList.toggle('sv-avatar_image', !!safe);
    if (safe) {
      const img = el('img', 'sv-avatar__image');
      img.src = safe;
      img.alt = '';
      slot.appendChild(img);
      slot.style.removeProperty('background-color');
    } else {
      slot.textContent = Array.from((nick || '?').trim())[0] || '?';
      slot.style.setProperty('background-color', hue(nick || '?'));
    }
  }

  /**
   * Пропускает только аватары PNG, JPEG и WebP в base64.
   * @param {*} value Значение
   * @returns {string} Аватар или пустая строка
   */
  function cleanAvatar(value) {
    return typeof value === 'string' && value.length < 200000 && AVATAR_RE.test(value) ? value : '';
  }

  /**
   * Строка без управляющих символов и ограниченной длины.
   * @param {*} value Значение
   * @param {number} max Наибольшая длина
   * @returns {string}
   */
  function cleanText(value, max) {
    return String(value == null ? '' : value).replace(/[\p{Cc}\p{Cf}]/gu, '').slice(0, max);
  }

  /**
   * Безопасное имя файла для сохранения.
   * @param {*} value Имя от отправителя
   * @returns {string}
   */
  function cleanFileName(value) {
    const name = cleanText(value, 200).replace(/[\\/:*?"<>|]/g, '_').replace(/^[\s.]+|[\s.]+$/g, '');
    return /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(name) ? `_${name}` : (name || 'file');
  }

  /**
   * Приводит данные участника от сервера к ожидаемому виду.
   * @param {object} p Участник
   * @returns {{id:number, nick:string, avatar:string, muted:boolean, deafened:boolean, lastAudio:number}}
   */
  function normPeer(p) {
    return {
      id: Number(p && p.id) | 0,
      nick: cleanText(p && p.nick, 32) || 'Гость',
      avatar: cleanAvatar(p && p.avatar),
      muted: !!(p && p.muted),
      deafened: !!(p && p.deafened),
      screen: p && SCREEN_CODEC_RE.test(String(p.screen || '')) ? String(p.screen) : '',
      lastAudio: 0,
    };
  }

  /**
   * Пауза.
   * @param {number} ms Миллисекунды
   * @returns {Promise<void>}
   */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ---------- Подключение ---------- */

  /**
   * Разбирает «ip» или «ip:порт».
   * @param {string} text Строка
   * @returns {{host:string, port:number}|null}
   */
  function parseAddress(text) {
    const s = text.trim().replace(/^wss?:\/\//i, '').replace(/\/+$/, '');
    if (!s) return null;
    const def = settings.port || DEFAULT_PORT;
    if (s.startsWith('[')) {
      const m = s.match(/^\[([^\]]+)\](?::(\d{1,5}))?$/);
      return m ? { host: m[1], port: Number(m[2]) || def } : null;
    }
    if ((s.match(/:/g) || []).length > 1) return { host: s, port: def };
    const [host, port] = s.split(':');
    if (!host) return null;
    return { host, port: Number(port) || def };
  }

  /**
   * Подключается к комнате.
   * @param {string} host Адрес
   * @param {number} port Порт
   */
  function connect(host, port) {
    if (st.ws) return;
    showError('');
    st.connecting = true;
    st.leaving = false;
    renderAll();
    const h = host.includes(':') ? `[${host}]` : host;
    let ws;
    try {
      ws = new WebSocket(`ws://${h}:${port}`);
    } catch (e) {
      st.connecting = false;
      showError('Неверный адрес');
      renderAll();
      return;
    }
    ws.binaryType = 'arraybuffer';
    st.ws = ws;
    const timeout = setTimeout(() => {
      if (!st.connected) {
        showError('Сервер не отвечает');
        ws.close();
      }
    }, 8000);

    ws.onopen = () => {
      ws.send(JSON.stringify({
        t: 'hello',
        nick: myNick(),
        avatar: settings.avatar,
        password: settings.password,
        muted: st.muted || st.deafened,
        deafened: st.deafened,
      }));
    };
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') onJson(e.data);
      else onBinary(e.data);
    };
    ws.onclose = () => {
      clearTimeout(timeout);
      const wasConnected = st.connected;
      cleanupCall();
      if (!st.leaving) {
        if (wasConnected) showError('Соединение потеряно');
        else if (!$('connError').textContent) showError('Не удалось подключиться');
      }
      if (st.hosting && !st.leaving) stopHosting();
    };
    ws.onerror = () => { /* причину покажет onclose */ };
  }

  /**
   * Выходит из звонка.
   */
  function disconnect() {
    st.leaving = true;
    if (st.ws) st.ws.close();
    cleanupCall();
  }

  /**
   * Сбрасывает всё, что относится к звонку: участники, чат, файлы.
   */
  function cleanupCall() {
    clearInterval(st.pingTimer);
    if (st.sharing) { st.sharing = false; sender.stop(); }
    if (st.watching) {
      st.watching = 0;
      viewer.close();
      if (st.view === 'screen') setView('chat');
    }
    closePicker();
    st.ws = null;
    st.connected = false;
    st.connecting = false;
    st.myId = 0;
    st.peers.clear();
    st.transmitting = false;
    st.rtt = -1;
    for (const o of st.outgoing.values()) o.cancelled = true;
    st.outgoing.clear();
    for (const f of st.incoming.values()) if (f.url) URL.revokeObjectURL(f.url);
    st.incoming.clear();
    st.pendingPreviews.clear();
    st.messagesByMid.clear();
    clearMessages();
    if (st.view !== 'settings') engine.stop();
    renderAll();
  }

  /**
   * Отправляет JSON на сервер.
   * @param {object} obj Сообщение
   */
  function send(obj) {
    if (st.ws && st.ws.readyState === WebSocket.OPEN) st.ws.send(JSON.stringify(obj));
  }

  /**
   * Обрабатывает JSON от сервера.
   * @param {string} text Текст
   */
  function onJson(text) {
    let m;
    try { m = JSON.parse(text); } catch (e) { return; }
    switch (m.t) {
      case 'welcome':
        st.connected = true;
        st.connecting = false;
        st.myId = m.id;
        st.peers.clear();
        for (const p of Array.isArray(m.peers) ? m.peers : []) st.peers.set(Number(p.id) | 0, normPeer(p));
        startPing();
        if (!engine.running) startAudio();
        addSystem('Вы вошли в звонок');
        renderAll();
        break;
      case 'error':
        showError(m.text || 'Ошибка сервера');
        st.leaving = true;
        break;
      case 'join': {
        const peer = normPeer(m.peer);
        st.peers.set(peer.id, peer);
        addSystem(`${peer.nick} подключился`);
        renderAll();
        break;
      }
      case 'leave': {
        const p = st.peers.get(m.id);
        st.peers.delete(m.id);
        engine.removePeer(m.id);
        if (p) addSystem(`${p.nick} вышел`);
        if (st.watching === m.id) stopWatching();
        for (const [key, f] of st.incoming) {
          if (f.from === m.id && f.state === 'recv') { f.state = 'cancel'; updateFileCard(key); }
        }
        renderAll();
        break;
      }
      case 'state': {
        const p = st.peers.get(m.id);
        if (p) { p.muted = m.muted; p.deafened = m.deafened; renderPeers(); }
        break;
      }
      case 'profile': {
        const p = st.peers.get(m.peer.id);
        if (p) {
          const n = normPeer(m.peer);
          p.nick = n.nick;
          p.avatar = n.avatar;
          renderPeers();
          renderOverlayPeers();
        }
        break;
      }
      case 'pong':
        st.rtt = Math.round(performance.now() - m.ts);
        renderStatus();
        break;
      case 'chat': {
        const id = Number(m.id) | 0;
        const mid = Number(m.mid) >>> 0;
        addChat(id, mid, String(m.text == null ? '' : m.text).replace(/[\p{Cc}\p{Cf}]/gu, (ch) => (ch === '\n' ? ch : '')).slice(0, 2000), Number(m.ts) || Date.now());
        if (id === st.myId && st.pendingPreviews.has(m.n)) {
          const url = st.pendingPreviews.get(m.n);
          st.pendingPreviews.delete(m.n);
          requestPreview(mid, url);
        }
        break;
      }
      case 'chat-preview':
        showPreview(Number(m.mid) >>> 0, m.preview);
        break;
      case 'notice':
        addSystem(cleanText(m.text, 200));
        break;
      case 'file-reject':
        onFileReject(m);
        break;
      case 'file-offer':
        onFileOffer(m);
        break;
      case 'file-end':
        onFileEnd(m);
        break;
      case 'file-cancel':
        onFileCancel(m);
        break;
      case 'file-ack':
        onFileAck(m);
        break;
      case 'screen-start': {
        const p = st.peers.get(Number(m.id) | 0);
        if (p && SCREEN_CODEC_RE.test(String(m.codec || ''))) {
          const restart = st.watching === p.id && p.screen !== m.codec;
          p.screen = String(m.codec);
          if (restart) startWatching(p.id);
          else if (!p.screenAnnounced) addSystem(`${p.nick} показывает экран`);
          p.screenAnnounced = true;
          renderPeers();
        }
        break;
      }
      case 'screen-stop': {
        const p = st.peers.get(Number(m.id) | 0);
        if (p) {
          p.screen = '';
          p.screenAnnounced = false;
          if (st.watching === p.id) stopWatching();
          renderPeers();
        }
        break;
      }
      case 'screen-keyframe':
        sender.requestKeyframe();
        break;
      default:
        break;
    }
  }

  /**
   * Обрабатывает двоичный кадр от сервера.
   * @param {ArrayBuffer} buf Данные
   */
  function onBinary(buf) {
    if (buf.byteLength < 4) return;
    const dv = new DataView(buf);
    const type = dv.getUint8(0);
    const id = dv.getUint16(2, true);
    if (type === T_AUDIO) {
      if ((buf.byteLength - 4) % 2) return;
      const p = st.peers.get(id);
      if (p) p.lastAudio = performance.now();
      if (!st.deafened) engine.play(id, new Int16Array(buf, 4));
    } else if (type === T_FILE && buf.byteLength >= 8) {
      onFileChunk(id, dv.getUint32(4, true), new Uint8Array(buf, 8));
    } else if (type === T_SCREEN && buf.byteLength > 8) {
      if (id === st.watching) {
        viewer.push((dv.getUint8(1) & 1) === 1, dv.getUint32(4, true), new Uint8Array(buf, 8));
        $('screenHint').hidden = true;
      }
    }
  }

  /**
   * Периодически меряет задержку.
   */
  function startPing() {
    clearInterval(st.pingTimer);
    const ping = () => send({ t: 'ping', ts: performance.now() });
    ping();
    st.pingTimer = setInterval(ping, 2000);
  }

  /* ---------- Сервер ---------- */

  /**
   * Поднимает свой сервер и подключается к нему.
   */
  async function startHosting() {
    showError('');
    const res = await api.startServer({ port: settings.port, password: settings.password });
    if (!res.ok) {
      showError(res.error || 'Не удалось запустить сервер');
      return;
    }
    st.hosting = true;
    st.hostPort = res.port;
    const info = $('hostInfo');
    info.textContent = '';
    const head = el('div', 'sv-sidebar__info-line');
    head.append(el('span', 'sv-sidebar__ok', 'Сервер запущен'), document.createTextNode(`порт ${res.port}`));
    const pub = el('div', 'sv-sidebar__info-line', 'Внешний IP: определяется…');
    info.append(head, pub);
    const addrs = (res.addresses || []).join(', ');
    if (addrs) info.appendChild(el('div', 'sv-sidebar__info-line', `Локальный: ${addrs}`));
    showPublicIp(pub, res.port);
    renderAll();
    connect('127.0.0.1', res.port);
  }

  /**
   * Показывает внешний IP хоста с кнопкой копирования.
   * @param {HTMLElement} line Строка для вывода
   * @param {number} port Порт сервера
   */
  async function showPublicIp(line, port) {
    let ip = '';
    try { ip = await api.publicIp(); } catch (e) { ip = ''; }
    if (!st.hosting) return;
    line.textContent = '';
    if (!ip) {
      line.textContent = 'Внешний IP: не удалось определить';
      return;
    }
    const address = port === DEFAULT_PORT ? ip : `${ip}:${port}`;
    const btn = el('button', 'sv-sidebar__ip', address);
    btn.type = 'button';
    btn.title = 'Скопировать адрес для друзей';
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(address);
        btn.textContent = 'Скопировано';
      } catch (e) {
        btn.textContent = 'Не скопировалось';
      }
      setTimeout(() => { btn.textContent = address; }, 1500);
    });
    line.append(document.createTextNode('Внешний IP:'), btn);
  }

  /* ---------- Демонстрация экрана ---------- */

  /**
   * Открывает выбор экрана или окна для показа.
   */
  async function openPicker() {
    const box = $('pickerSources');
    box.textContent = '';
    box.appendChild(el('div', 'sv-modal__empty', 'Загружаю список…'));
    $('pickerError').hidden = true;
    $('pickerStart').disabled = true;
    st.pickedSource = '';
    const q = document.querySelector(`input[name="quality"][value="${settings.screenQuality}"]`) || document.querySelector('input[name="quality"][value="1080p30"]');
    q.checked = true;
    $('picker').hidden = false;
    let list = [];
    try { list = (await api.screenSources()) || []; } catch (e) { list = []; }
    box.textContent = '';
    if (!list.length) {
      box.appendChild(el('div', 'sv-modal__empty', 'Не нашлось экранов и окон для показа'));
      return;
    }
    for (const src of list) {
      const b = el('button', 'sv-modal__source');
      b.type = 'button';
      b.dataset.id = src.id;
      const img = el('img', 'sv-modal__thumb');
      if (typeof src.thumb === 'string' && src.thumb.startsWith('data:image/')) img.src = src.thumb;
      img.alt = '';
      const label = src.kind === 'screen' ? `Экран: ${src.name}` : src.name;
      b.append(img, el('span', 'sv-modal__name', label));
      b.title = label;
      b.addEventListener('click', () => {
        st.pickedSource = src.id;
        for (const x of box.children) x.classList.toggle('sv-modal__source_selected', x === b);
        $('pickerStart').disabled = false;
      });
      b.addEventListener('dblclick', startSharing);
      box.appendChild(b);
    }
    box.firstElementChild.focus();
  }

  /**
   * Закрывает выбор источника.
   */
  function closePicker() {
    $('picker').hidden = true;
    $('pickerSources').textContent = '';
    st.pickedSource = '';
  }

  /**
   * Начинает показ выбранного источника.
   */
  async function startSharing() {
    if (!st.pickedSource || !st.connected || st.sharing) return;
    const quality = (document.querySelector('input[name="quality"]:checked') || {}).value || '1080p30';
    settings.screenQuality = quality;
    saveSettings();
    $('pickerStart').disabled = true;
    api.screenSelect(st.pickedSource);
    try {
      const codec = await sender.start(quality);
      st.sharing = true;
      send({ t: 'screen-start', codec });
      closePicker();
      addSystem('Вы показываете экран');
      renderControls();
      renderPeers();
    } catch (e) {
      api.screenSelect('');
      $('pickerError').textContent = e && e.message ? e.message : 'Не удалось начать показ';
      $('pickerError').hidden = false;
      $('pickerStart').disabled = false;
    }
  }

  /**
   * Начинает смотреть экран участника.
   * @param {number} id Id показывающего
   */
  async function startWatching(id) {
    const p = st.peers.get(id);
    if (!p || !p.screen) return;
    if (st.watching && st.watching !== id) send({ t: 'screen-watch', id: st.watching, on: false });
    st.watching = id;
    $('screenTitle').textContent = `Экран: ${p.nick}`;
    $('screenHint').textContent = 'Ждём изображение…';
    $('screenHint').hidden = false;
    setView('screen');
    try {
      await viewer.open(p.screen);
    } catch (e) {
      $('screenHint').textContent = e && e.message ? e.message : 'Не удалось открыть видео';
      return;
    }
    if (st.watching !== id) return;
    send({ t: 'screen-watch', id, on: true });
    renderPeers();
  }

  /**
   * Перестаёт смотреть экран.
   */
  function stopWatching() {
    if (!st.watching) return;
    send({ t: 'screen-watch', id: st.watching, on: false });
    st.watching = 0;
    viewer.close();
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    if (st.view === 'screen') setView('chat');
    renderPeers();
  }

  /* ---------- Обновления ---------- */

  /**
   * Проверяет обновления и показывает результат.
   * @param {boolean} silent Без сообщений, если обновлений нет или нет связи
   */
  async function checkUpdates(silent) {
    const status = $('updateStatus');
    const btn = $('updateCheckBtn');
    if (!silent) { status.textContent = 'Проверяю…'; btn.disabled = true; }
    let res;
    try { res = await api.checkUpdate(); } catch (e) { res = { ok: false, error: 'Ошибка проверки' }; }
    btn.disabled = false;
    st.update = res;
    const install = $('updateInstallBtn');
    if (!res || !res.ok) {
      if (!silent) status.textContent = (res && res.error) || 'Не удалось проверить';
      install.hidden = true;
      return;
    }
    if (res.available) {
      status.textContent = `Доступна версия ${res.latest}`;
      install.hidden = false;
      install.textContent = res.canInstall ? `Обновить до ${res.latest}` : 'Открыть страницу релиза';
      $('updateBannerText').textContent = `Доступна версия ${res.latest}`;
      $('updateBanner').hidden = false;
    } else {
      install.hidden = true;
      $('updateBanner').hidden = true;
      if (!silent) status.textContent = 'У вас последняя версия';
    }
  }

  /**
   * Скачивает и ставит обновление; программа перезапустится сама.
   */
  async function installUpdate() {
    const res = st.update;
    if (!res || !res.available) return;
    if (!res.canInstall) { api.openReleases(); return; }
    const install = $('updateInstallBtn');
    install.disabled = true;
    $('updateCheckBtn').disabled = true;
    $('updateProgress').hidden = false;
    $('updateStatus').textContent = 'Скачиваю…';
    const out = await api.installUpdate();
    if (out && out.ok) {
      $('updateStatus').textContent = 'Готово, перезапускаю…';
      return;
    }
    install.disabled = false;
    $('updateCheckBtn').disabled = false;
    $('updateProgress').hidden = true;
    $('updateStatus').textContent = (out && out.error) || 'Не удалось обновить';
  }

  /**
   * Останавливает свой сервер.
   */
  async function stopHosting() {
    st.hosting = false;
    renderAll();
    await api.stopServer();
  }

  /* ---------- Звук ---------- */

  /**
   * Запускает звуковой движок с текущими настройками.
   */
  async function startAudio() {
    try {
      await engine.start({
        inputId: settings.inputId,
        outputId: settings.outputId,
        noiseSuppression: settings.noiseSuppression,
        inputGain: settings.inputGain,
        outputVolume: settings.outputVolume,
      });
      engine.setDeafened(st.deafened);
      refreshDevices();
    } catch (e) {
      addSystem('Не удалось открыть микрофон: ' + (e && e.message ? e.message : e));
    }
  }

  /**
   * Каждый кадр микрофона: индикатор уровня и решение, передавать ли голос.
   * @param {Int16Array} pcm Кадр
   * @param {number} rms Громкость 0..1
   */
  function onMicFrame(pcm, rms) {
    const db = rms > 0 ? 20 * Math.log10(rms) : -100;
    st.level = db;
    const now = performance.now();
    if (db > settings.vadThreshold) st.lastVoice = now;

    let tx = false;
    if (st.connected && !st.muted && !st.deafened) {
      tx = settings.mode === 'ptt' ? st.pttDown : (now - st.lastVoice < VAD_HOLD_MS);
    }
    st.transmitting = tx;
    if (!tx) return;
    const ws = st.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > 256 * 1024) return;
    const out = new Uint8Array(2 + pcm.byteLength);
    out[0] = T_AUDIO;
    out.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), 2);
    ws.send(out);
  }

  /**
   * Список устройств в настройках.
   */
  async function refreshDevices() {
    let list = [];
    try { list = await navigator.mediaDevices.enumerateDevices(); } catch (e) { return; }
    fillSelect($('inputSelect'), list.filter((d) => d.kind === 'audioinput'), settings.inputId, 'Микрофон');
    fillSelect($('outputSelect'), list.filter((d) => d.kind === 'audiooutput'), settings.outputId, 'Динамики');
  }

  /**
   * Заполняет выпадающий список устройств.
   * @param {HTMLSelectElement} sel Список
   * @param {MediaDeviceInfo[]} devices Устройства
   * @param {string} current Выбранный id
   * @param {string} fallback Подпись без имени
   */
  function fillSelect(sel, devices, current, fallback) {
    sel.textContent = '';
    const def = el('option', '', 'По умолчанию (система)');
    def.value = 'default';
    sel.appendChild(def);
    devices.forEach((d, i) => {
      if (d.deviceId === 'default' || d.deviceId === 'communications') return;
      const o = el('option', '', d.label || `${fallback} ${i + 1}`);
      o.value = d.deviceId;
      sel.appendChild(o);
    });
    sel.value = [...sel.options].some((o) => o.value === current) ? current : 'default';
  }

  /* ---------- Чат ---------- */

  /**
   * Очищает ленту.
   */
  function clearMessages() {
    const box = $('messages');
    const empty = $('chatEmpty') || makeEmpty();
    box.textContent = '';
    empty.hidden = false;
    box.appendChild(empty);
  }

  /**
   * Заглушка пустой ленты.
   * @returns {HTMLElement}
   */
  function makeEmpty() {
    const e = el('div', 'sv-messages__empty', 'Здесь появятся сообщения и файлы этого звонка');
    e.dataset.sv = 'chatEmpty';
    return e;
  }

  /**
   * Добавляет элемент в ленту и прокручивает вниз, если пользователь внизу.
   * @param {HTMLElement} node Элемент
   */
  function pushMessage(node) {
    const box = $('messages');
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
    $('chatEmpty').hidden = true;
    box.appendChild(node);
    while (box.children.length > MAX_MESSAGES + 1) {
      const first = box.children[0] === $('chatEmpty') ? box.children[1] : box.children[0];
      if (first.dataset.mid) st.messagesByMid.delete(Number(first.dataset.mid));
      first.remove();
    }
    if (atBottom) box.scrollTop = box.scrollHeight;
  }

  /**
   * Служебная строка в ленте.
   * @param {string} text Текст
   */
  function addSystem(text) {
    pushMessage(el('div', 'sv-message sv-message_system', text));
  }

  /**
   * Каркас сообщения от участника.
   * @param {number} id Id автора
   * @param {number} ts Время
   * @returns {{root:HTMLElement, body:HTMLElement}}
   */
  function messageShell(id, ts) {
    const p = st.peers.get(id) || { nick: '???', avatar: '' };
    const root = el('div', 'sv-message');
    const av = el('div', 'sv-avatar');
    fillAvatar(av, p.avatar, p.nick);
    const body = el('div', 'sv-message__body');
    const head = el('div', 'sv-message__head');
    head.append(el('span', 'sv-message__nick', p.nick), el('span', 'sv-message__time', fmtTime(ts)));
    body.appendChild(head);
    root.append(av, body);
    return { root, body };
  }

  /**
   * Текстовое сообщение.
   * @param {number} id Автор
   * @param {string} text Текст
   * @param {number} ts Время
   */
  function addChat(id, mid, text, ts) {
    const { root, body } = messageShell(id, ts);
    const box = el('div', 'sv-message__text');
    linkify(box, text);
    body.appendChild(box);
    if (mid) {
      root.dataset.mid = String(mid);
      st.messagesByMid.set(mid, body);
    }
    pushMessage(root);
  }

  /**
   * Первая ссылка http(s) в тексте.
   * @param {string} text Текст
   * @returns {string}
   */
  function firstUrl(text) {
    const parts = splitLinks(text);
    const link = parts.find((p) => p.url);
    return link ? link.url : '';
  }

  /**
   * Делит текст на обычные куски и ссылки.
   * @param {string} text Текст
   * @returns {{text:string, url?:string}[]}
   */
  function splitLinks(text) {
    const out = [];
    const re = /\bhttps?:\/\/[^\s<>"'«»]+/gi;
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      let raw = m[0];
      raw = raw.replace(/[.,;:!?\]}]+$/, '');
      while (raw.endsWith(')') && (raw.match(/\)/g) || []).length > (raw.match(/\(/g) || []).length) raw = raw.slice(0, -1);
      raw = raw.replace(/[.,;:!?]+$/, '');
      let url = '';
      try {
        const u = new URL(raw);
        if (u.protocol === 'http:' || u.protocol === 'https:') url = u.href;
      } catch (e) {
        url = '';
      }
      if (m.index > last) out.push({ text: text.slice(last, m.index) });
      out.push(url ? { text: raw, url } : { text: raw });
      last = m.index + raw.length;
      re.lastIndex = last;
    }
    if (last < text.length) out.push({ text: text.slice(last) });
    return out;
  }

  /**
   * Выводит текст, превращая ссылки в кликабельные (открываются в браузере).
   * @param {HTMLElement} box Куда выводить
   * @param {string} text Текст
   */
  function linkify(box, text) {
    for (const part of splitLinks(text)) {
      if (!part.url) { box.appendChild(document.createTextNode(part.text)); continue; }
      const a = el('a', 'sv-message__link', part.text);
      a.href = part.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.title = part.url;
      box.appendChild(a);
    }
  }

  /**
   * Собирает предпросмотр своей ссылки и рассылает его участникам.
   * @param {number} mid Id сообщения
   * @param {string} url Ссылка
   */
  async function requestPreview(mid, url) {
    let preview = null;
    try { preview = await api.linkPreview(url); } catch (e) { preview = null; }
    if (preview && st.connected) send({ t: 'chat-preview', mid, preview });
  }

  /**
   * Добавляет карточку предпросмотра под сообщением.
   * @param {number} mid Id сообщения
   * @param {object} p Предпросмотр
   */
  function showPreview(mid, p) {
    if (!settings.linkPreview || !p || typeof p !== 'object') return;
    const body = st.messagesByMid.get(mid);
    if (!body || !body.isConnected || body.querySelector('.sv-preview')) return;
    let url = '';
    try {
      const u = new URL(String(p.url || ''));
      if (u.protocol === 'http:' || u.protocol === 'https:') url = u.href;
    } catch (e) {
      url = '';
    }
    const title = cleanText(p.title, 200);
    if (!url || !title) return;
    const box = $('messages');
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
    const card = el('a', 'sv-preview');
    card.href = url;
    card.target = '_blank';
    card.rel = 'noopener noreferrer';
    const info = el('span', 'sv-preview__info');
    const site = cleanText(p.site, 100);
    if (site) info.appendChild(el('span', 'sv-preview__site', site));
    info.appendChild(el('span', 'sv-preview__title', title));
    const desc = cleanText(p.description, 300);
    if (desc) info.appendChild(el('span', 'sv-preview__desc', desc));
    card.appendChild(info);
    const image = typeof p.image === 'string' && p.image.length < 150000 && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(p.image) ? p.image : '';
    if (image) {
      const img = el('img', 'sv-preview__image');
      img.src = image;
      img.alt = '';
      img.loading = 'lazy';
      card.appendChild(img);
    }
    body.appendChild(card);
    if (atBottom) box.scrollTop = box.scrollHeight;
  }

  /* ---------- Файлы ---------- */

  /**
   * Карточка файла в ленте.
   * @param {string} key Ключ передачи
   * @param {number} from Отправитель
   * @param {string} name Имя файла
   * @returns {object} Ссылки на элементы карточки
   */
  function makeFileCard(key, from, name) {
    const { root, body } = messageShell(from, Date.now());
    const card = el('div', 'sv-file');
    const ic = el('div', 'sv-file__icon');
    ic.appendChild(icon('file'));
    const info = el('div', 'sv-file__info');
    const nm = el('div', 'sv-file__name', name);
    nm.title = name;
    const state = el('div', 'sv-file__state');
    const prog = el('div', 'sv-file__progress');
    const bar = el('i', 'sv-file__progress-bar');
    prog.appendChild(bar);
    info.append(nm, state, prog);
    const act = el('button', 'sv-file__action');
    act.type = 'button';
    act.appendChild(icon('x'));
    act.title = 'Отменить';
    act.addEventListener('click', () => onFileAction(key));
    card.append(ic, info, act);
    body.appendChild(card);
    pushMessage(root);
    return { state, bar, prog, act };
  }

  /**
   * Обновляет карточку файла по его состоянию.
   * @param {string} key Ключ передачи
   */
  function updateFileCard(key) {
    const f = st.outgoing.get(key) || st.incoming.get(key);
    if (!f || !f.ui) return;
    const pct = f.size ? Math.min(100, Math.floor((f.done / f.size) * 100)) : 100;
    const ui = f.ui;
    ui.bar.style.transform = `scaleX(${pct / 100})`;
    const set = (text, showProg, act) => {
      ui.state.textContent = text;
      ui.prog.hidden = !showProg;
      ui.act.hidden = !act;
      if (act) {
        ui.act.textContent = '';
        ui.act.appendChild(icon(act));
        ui.act.className = act === 'down' ? 'sv-file__action sv-file__action_save' : 'sv-file__action';
        ui.act.setAttribute('aria-label', act === 'down' ? 'Сохранить' : 'Отменить');
        ui.act.title = act === 'down' ? 'Сохранить' : 'Отменить';
      }
    };
    switch (f.state) {
      case 'send': set(`Передача ${pct}% · ${fmtSize(f.size)}`, true, 'x'); break;
      case 'recv': set(`Получение ${pct}% · ${fmtSize(f.size)}`, true, 'x'); break;
      case 'sent': set(`Отправлено · ${fmtSize(f.size)}`, false, null); break;
      case 'ready': set(`Получен · ${fmtSize(f.size)} · можно сохранить до конца звонка`, false, 'down'); break;
      case 'saved': set(`Сохранён · ${fmtSize(f.size)}`, false, 'down'); break;
      case 'cancel': set('Передача отменена', false, null); break;
      case 'skip': set(`Пропущен · ${fmtSize(f.size)} · слишком большой объём файлов за звонок`, false, null); break;
      case 'reject': set(f.reason || 'Сервер не принял файл', false, null); break;
      default: break;
    }
  }

  /**
   * Нажатие на кнопку карточки: отмена или сохранение.
   * @param {string} key Ключ передачи
   */
  function onFileAction(key) {
    const out = st.outgoing.get(key);
    if (out) {
      if (out.state === 'send') {
        out.cancelled = true;
        out.state = 'cancel';
        send({ t: 'file-cancel', fid: out.fid });
        updateFileCard(key);
      }
      return;
    }
    const f = st.incoming.get(key);
    if (!f) return;
    if (f.state === 'recv') {
      f.state = 'cancel';
      f.chunks = [];
      updateFileCard(key);
    } else if (f.state === 'ready' || f.state === 'saved') {
      const a = el('a');
      a.href = f.url;
      a.download = f.name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      f.state = 'saved';
      updateFileCard(key);
    }
  }

  /**
   * Отправляет выбранные файлы участникам звонка.
   * @param {FileList} files Файлы
   */
  function sendFiles(files) {
    for (const file of files) {
      if (file.size === 0) { addSystem(`«${file.name}» пустой — пропущен`); continue; }
      if (file.size > MAX_FILE) { addSystem(`«${file.name}» больше 2 ГБ — пропущен`); continue; }
      sendFile(file);
    }
  }

  /**
   * Отправляет один файл кусками с ограничением числа неподтверждённых кусков.
   * @param {File} file Файл
   */
  async function sendFile(file) {
    const fid = crypto.getRandomValues(new Uint32Array(1))[0] || 1;
    const key = `me:${fid}`;
    const total = Math.ceil(file.size / FILE_CHUNK);
    const o = { fid, name: file.name, size: file.size, done: 0, sentChunks: 0, acked: 0, total, state: 'send', cancelled: false, wake: null, ui: null };
    st.outgoing.set(key, o);
    o.ui = makeFileCard(key, st.myId, file.name);
    updateFileCard(key);
    send({ t: 'file-offer', fid, name: file.name, size: file.size });

    for (let i = 0; i < total; i++) {
      while (!o.cancelled && st.ws && (o.sentChunks - o.acked >= FILE_WINDOW || st.ws.bufferedAmount > 1024 * 1024)) {
        await new Promise((r) => { o.wake = r; setTimeout(r, 100); });
      }
      if (o.cancelled || !st.ws || st.ws.readyState !== WebSocket.OPEN) return;
      const start = i * FILE_CHUNK;
      const data = new Uint8Array(await file.slice(start, start + FILE_CHUNK).arrayBuffer());
      if (o.cancelled || !st.ws) return;
      const frame = new Uint8Array(6 + data.length);
      frame[0] = T_FILE;
      new DataView(frame.buffer).setUint32(2, fid, true);
      frame.set(data, 6);
      st.ws.send(frame);
      o.sentChunks++;
    }
    send({ t: 'file-end', fid });
    while (!o.cancelled && st.ws && o.acked < total) await sleep(100);
    if (o.cancelled) return;
    o.done = o.size;
    o.state = 'sent';
    updateFileCard(key);
  }

  /**
   * Сервер подтвердил приём кусков.
   * @param {{fid:number, n:number}} m Сообщение
   */
  function onFileAck(m) {
    const key = `me:${m.fid}`;
    const o = st.outgoing.get(key);
    if (!o) return;
    o.acked += m.n;
    o.done = Math.min(o.size, o.acked * FILE_CHUNK);
    if (o.wake) { const w = o.wake; o.wake = null; w(); }
    if (o.state === 'send') updateFileCard(key);
  }

  /**
   * Кто-то начал отправлять файл.
   * @param {object} m Сообщение
   */
  function onFileOffer(m) {
    const from = Number(m.id) | 0;
    const fid = Number(m.fid) >>> 0;
    const size = Number(m.size);
    const key = `${from}:${fid}`;
    if (!fid || st.incoming.has(key) || !Number.isSafeInteger(size) || size <= 0) return;
    const name = cleanFileName(m.name);
    let used = 0;
    for (const x of st.incoming.values()) if (x.state === 'recv' || x.state === 'ready' || x.state === 'saved') used += x.size;
    const f = { from, fid, name, size, done: 0, chunks: [], state: 'recv', url: '', ui: null };
    if (size > MAX_FILE || used + size > MAX_INCOMING) f.state = 'skip';
    st.incoming.set(key, f);
    f.ui = makeFileCard(key, from, name);
    updateFileCard(key);
  }

  /**
   * Сервер отказал в отправке файла.
   * @param {{fid:number, text:string}} m Сообщение
   */
  function onFileReject(m) {
    const key = `me:${Number(m.fid) >>> 0}`;
    const o = st.outgoing.get(key);
    if (!o) return;
    o.cancelled = true;
    o.state = 'reject';
    o.reason = cleanText(m.text, 200);
    updateFileCard(key);
  }

  /**
   * Кусок входящего файла.
   * @param {number} from Отправитель
   * @param {number} fid Id передачи
   * @param {Uint8Array} data Данные
   */
  function onFileChunk(from, fid, data) {
    const key = `${from}:${fid}`;
    const f = st.incoming.get(key);
    if (!f || f.state !== 'recv') return;
    f.done += data.length;
    if (f.done > f.size) {
      f.state = 'cancel';
      f.chunks = [];
      updateFileCard(key);
      return;
    }
    f.chunks.push(data);
    if (!f.lastPaint || performance.now() - f.lastPaint > 150) {
      f.lastPaint = performance.now();
      updateFileCard(key);
    }
  }

  /**
   * Отправитель закончил передачу.
   * @param {{id:number, fid:number}} m Сообщение
   */
  function onFileEnd(m) {
    const key = `${m.id}:${m.fid}`;
    const f = st.incoming.get(key);
    if (!f || f.state !== 'recv') return;
    if (f.done !== f.size) { f.state = 'cancel'; f.chunks = []; updateFileCard(key); return; }
    f.url = URL.createObjectURL(new Blob(f.chunks));
    f.chunks = [];
    f.state = 'ready';
    updateFileCard(key);
  }

  /**
   * Отправитель отменил передачу.
   * @param {{id:number, fid:number}} m Сообщение
   */
  function onFileCancel(m) {
    const key = `${m.id}:${m.fid}`;
    const f = st.incoming.get(key);
    if (!f || f.state !== 'recv') return;
    f.state = 'cancel';
    f.chunks = [];
    updateFileCard(key);
  }

  /* ---------- Отрисовка ---------- */

  /**
   * Перерисовывает всё зависящее от состояния.
   */
  function renderAll() {
    renderSidebar();
    renderPeers();
    renderStatus();
    renderControls();
    renderOverlayPeers();
  }

  /**
   * Кнопки и поле боковой панели.
   */
  function renderSidebar() {
    const host = $('hostBtn');
    host.textContent = '';
    host.append(icon(st.hosting ? 'stop' : 'plus'), el('span', '', st.hosting ? 'Остановить сервер' : 'Поднять сервер'));
    host.className = st.hosting ? 'sv-button sv-button_danger sv-button_block' : 'sv-button sv-button_primary sv-button_block';
    host.disabled = !st.hosting && (st.connected || st.connecting);
    $('hostInfo').hidden = !st.hosting;

    const conn = $('connectBtn');
    const inCall = st.connected || st.connecting;
    conn.textContent = st.connecting ? 'Подключение…' : (st.connected ? 'Отключиться' : 'Подключиться');
    conn.className = st.connected ? 'sv-button sv-button_ghost sv-button_block' : 'sv-button sv-button_primary sv-button_block';
    conn.disabled = st.hosting || st.connecting;
    $('ipInput').disabled = inCall || st.hosting;
    $('composer').classList.toggle('sv-composer_disabled', !st.connected);
  }

  /**
   * Список участников.
   */
  function renderPeers() {
    const list = $('peers');
    list.textContent = '';
    const peers = sortedPeers();
    $('peersTitle').textContent = `Участники (${peers.length})`;
    for (const p of peers) {
      const li = el('li', 'sv-peer');
      li.dataset.id = String(p.id);
      if (p.id === st.myId) li.classList.add('sv-peer_me');
      const av = el('div', 'sv-avatar');
      fillAvatar(av, p.avatar, p.nick);
      const name = el('span', 'sv-peer__name', p.nick);
      const icons = el('span', 'sv-peer__icons');
      const muted = p.id === st.myId ? (st.muted || st.deafened) : p.muted;
      const deaf = p.id === st.myId ? st.deafened : p.deafened;
      if (deaf) icons.appendChild(icon('head-off', 'off'));
      icons.appendChild(muted ? icon('mic-off', 'off') : icon('mic'));
      if (p.id === st.myId && st.sharing) {
        icons.appendChild(icon('screen', 'sv-peer__live'));
      } else if (p.id !== st.myId && p.screen) {
        const watch = el('button', 'sv-peer__watch');
        watch.type = 'button';
        watch.title = st.watching === p.id ? 'Открыть экран' : `Смотреть экран: ${p.nick}`;
        watch.setAttribute('aria-label', watch.title);
        watch.append(icon('screen'), document.createTextNode(st.watching === p.id ? 'Открыт' : 'Смотреть'));
        watch.addEventListener('click', () => {
          if (st.watching === p.id) setView('screen'); else startWatching(p.id);
        });
        icons.appendChild(watch);
      }
      const eq = el('span', 'sv-peer__eq');
      for (let i = 0; i < 4; i++) eq.appendChild(el('i', 'sv-peer__eq-bar'));
      icons.appendChild(eq);
      li.append(av, name, icons);
      list.appendChild(li);
    }
    st.lastSpeaking = '';
  }

  /**
   * Участники: сначала я, потом по порядку входа.
   * @returns {object[]}
   */
  function sortedPeers() {
    return [...st.peers.values()].sort((a, b) => (a.id === st.myId ? -1 : b.id === st.myId ? 1 : a.id - b.id));
  }

  /**
   * Строка состояния и индикатор сети.
   */
  function renderStatus() {
    const sig = $('signal');
    let text = 'Не подключено';
    let level = 0;
    if (st.connecting) text = 'Подключение…';
    if (st.connected) {
      const n = st.peers.size;
      text = `Звонок • ${n} ${plural(n, ['участник', 'участника', 'участников'])}`;
      if (st.rtt >= 0) {
        level = st.rtt < 80 ? 4 : st.rtt < 150 ? 3 : st.rtt < 300 ? 2 : 1;
        sig.title = `Задержка ${st.rtt} мс`;
      }
    }
    sig.dataset.level = String(level);
    $('statusText').textContent = text;
  }

  /**
   * Кнопки нижней панели.
   */
  function renderControls() {
    const mic = $('micBtn');
    const micOff = st.muted || st.deafened;
    mic.className = micOff ? 'sv-control sv-control_off' : 'sv-control sv-control_accent';
    mic.textContent = '';
    mic.appendChild(icon(micOff ? 'mic-off' : 'mic'));
    mic.title = micOff ? 'Включить микрофон' : 'Выключить микрофон';
    mic.setAttribute('aria-label', mic.title);
    mic.setAttribute('aria-pressed', String(micOff));

    const head = $('headBtn');
    head.className = st.deafened ? 'sv-control sv-control_off' : 'sv-control';
    head.textContent = '';
    head.appendChild(icon(st.deafened ? 'head-off' : 'head'));
    head.title = st.deafened ? 'Включить звук' : 'Выключить звук';
    head.setAttribute('aria-label', head.title);
    head.setAttribute('aria-pressed', String(st.deafened));

    const gear = $('settingsBtn');
    gear.classList.toggle('sv-control_active', st.view === 'settings');
    gear.title = st.view === 'settings' ? 'Вернуться в чат' : 'Настройки';
    gear.setAttribute('aria-label', gear.title);
    gear.textContent = '';
    gear.appendChild(icon(st.view === 'settings' ? 'chat' : 'gear'));

    $('hangupBtn').disabled = !(st.connected || st.connecting);

    const scr = $('screenBtn');
    scr.className = st.sharing ? 'sv-control sv-control_active' : 'sv-control';
    scr.textContent = '';
    scr.appendChild(icon('screen'));
    scr.title = st.sharing ? 'Остановить демонстрацию' : 'Показать экран';
    scr.setAttribute('aria-label', scr.title);
    scr.setAttribute('aria-pressed', String(st.sharing));
    scr.disabled = !st.connected;
  }

  /**
   * Каждые 100 мс: кто говорит — подсветка в списке и в оверлее.
   */
  function tickSpeaking() {
    const now = performance.now();
    const ids = [];
    for (const p of st.peers.values()) {
      const speaking = p.id === st.myId ? st.transmitting : (now - p.lastAudio < SPEAK_HOLD_MS && !st.deafened);
      if (speaking) ids.push(p.id);
    }
    const sig = ids.join(',');
    if (sig !== st.lastSpeaking) {
      st.lastSpeaking = sig;
      for (const li of $('peers').children) {
        li.classList.toggle('sv-peer_speaking', ids.includes(Number(li.dataset.id)));
      }
      api.overlaySpeaking(ids);
    }
    if (st.view === 'settings') {
      const level = Math.max(0, Math.min(1, (st.level + 80) / 70));
      $('meter').style.setProperty('--sv-level', engine.running ? level.toFixed(3) : '0');
    }
  }

  /**
   * Передаёт список участников в оверлей.
   */
  function renderOverlayPeers() {
    const data = {
      visible: settings.overlay && st.connected,
      peers: sortedPeers().map((p) => ({
        id: p.id,
        nick: p.nick,
        avatar: p.avatar,
        muted: p.id === st.myId ? (st.muted || st.deafened) : p.muted,
        color: hue(p.nick || '?'),
      })),
    };
    const sig = JSON.stringify(data);
    if (sig === st.overlaySig) return;
    st.overlaySig = sig;
    api.overlayPeers(data);
    st.lastSpeaking = '';
  }

  /**
   * Показывает ошибку под кнопкой подключения.
   * @param {string} text Текст или пустая строка
   */
  function showError(text) {
    const e = $('connError');
    e.textContent = text;
    e.hidden = !text;
  }

  /* ---------- Состояние микрофона ---------- */

  /**
   * Сообщает серверу о своих выключателях и обновляет вид.
   */
  function pushState() {
    const me = st.peers.get(st.myId);
    if (me) { me.muted = st.muted || st.deafened; me.deafened = st.deafened; }
    send({ t: 'state', muted: st.muted || st.deafened, deafened: st.deafened });
    engine.setDeafened(st.deafened);
    renderControls();
    renderPeers();
    renderOverlayPeers();
  }

  /**
   * Отправляет изменённый профиль.
   */
  function pushProfile() {
    const me = st.peers.get(st.myId);
    if (me) { me.nick = myNick(); me.avatar = settings.avatar; }
    send({ t: 'profile', nick: myNick(), avatar: settings.avatar });
    renderPeers();
    renderOverlayPeers();
  }

  /* ---------- Вид: чат / настройки ---------- */

  /**
   * Переключает правую часть окна.
   * @param {'chat'|'settings'} view Вид
   */
  async function setView(view) {
    st.view = view;
    $('chatView').hidden = view !== 'chat';
    $('settingsView').hidden = view !== 'settings';
    $('screenView').hidden = view !== 'screen';
    renderControls();
    if (view === 'settings') {
      fillSettings();
      if (!engine.running) await startAudio();
      else refreshDevices();
    } else {
      cancelKeyCapture();
      if (!st.connected && engine.running) engine.stop();
    }
  }

  /**
   * Заполняет форму настроек текущими значениями.
   */
  function fillSettings() {
    $('nickInput').value = settings.nick;
    fillAvatar($('avatarPreview'), settings.avatar, myNick());
    document.querySelector(`input[name="mode"][value="${settings.mode}"]`).checked = true;
    document.querySelector(`input[name="theme"][value="${settings.theme}"]`).checked = true;
    $('nsToggle').checked = settings.noiseSuppression;
    $('overlayToggle').checked = settings.overlay;
    $('previewToggle').checked = settings.linkPreview;
    $('vadRange').value = String(settings.vadThreshold);
    $('vadValue').textContent = `${settings.vadThreshold} дБ`;
    $('inGainRange').value = String(Math.round(settings.inputGain * 100));
    $('inGainValue').textContent = `${Math.round(settings.inputGain * 100)}%`;
    $('outVolRange').value = String(Math.round(settings.outputVolume * 100));
    $('outVolValue').textContent = `${Math.round(settings.outputVolume * 100)}%`;
    $('portInput').value = String(settings.port);
    $('passInput').value = settings.password;
    renderPttKey();
    renderModeBoxes();
  }

  /**
   * Подпись клавиши рации.
   */
  function renderPttKey() {
    const b = $('pttKeyBtn');
    b.classList.toggle('sv-button_waiting', st.capturingKey);
    b.textContent = st.capturingKey ? 'Нажмите клавишу…' : (settings.ptt ? settings.ptt.name : 'Не назначена');
    $('pttHint').textContent = st.pttAvailable ? (st.capturingKey ? 'Esc — отмена' : '') : 'Глобальная клавиша недоступна';
  }

  /**
   * Затемняет параметры неактивного режима.
   */
  function renderModeBoxes() {
    $('pttBox').classList.toggle('sv-row_off', settings.mode !== 'ptt');
    $('vadBox').classList.toggle('sv-row_off', settings.mode !== 'vad');
  }

  /**
   * Прекращает ожидание клавиши.
   */
  function cancelKeyCapture() {
    if (!st.capturingKey) return;
    st.capturingKey = false;
    api.capturePtt(false);
    renderPttKey();
  }

  /**
   * Уменьшает картинку до квадрата 128×128. Тип определяется декодированием, а не по имени файла.
   * @param {File} file Изображение
   * @returns {Promise<string>} Data URL
   */
  function makeAvatar(file) {
    return new Promise((resolve, reject) => {
      if (file.size > MAX_AVATAR_FILE) { reject(new Error('Картинка больше 10 МБ')); return; }
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        if (!img.width || !img.height || img.width > MAX_AVATAR_PX || img.height > MAX_AVATAR_PX) {
          URL.revokeObjectURL(url);
          reject(new Error('Слишком большое разрешение картинки'));
          return;
        }
        const size = 128;
        const c = document.createElement('canvas');
        c.width = size;
        c.height = size;
        const s = Math.min(img.width, img.height);
        c.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
        URL.revokeObjectURL(url);
        const webp = c.toDataURL('image/webp', 0.85);
        resolve(webp.startsWith('data:image/webp') ? webp : c.toDataURL('image/png'));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Это не картинка')); };
      img.src = url;
    });
  }

  /* ---------- События ---------- */

  /**
   * Навешивает обработчики интерфейса.
   */
  function bind() {
    $('winMin').addEventListener('click', () => api.minimize());
    $('winMax').addEventListener('click', () => api.maximize());
    $('winClose').addEventListener('click', () => api.close());

    $('hostBtn').addEventListener('click', async () => {
      if (st.hosting) {
        disconnect();
        await stopHosting();
      } else {
        await startHosting();
      }
    });

    $('connectBtn').addEventListener('click', () => {
      if (st.connected) { disconnect(); return; }
      const addr = parseAddress($('ipInput').value);
      if (!addr) { showError('Введите IP-адрес'); return; }
      settings.lastIp = $('ipInput').value.trim();
      saveSettings();
      connect(addr.host, addr.port);
    });
    $('ipInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('connectBtn').click(); });

    $('hangupBtn').addEventListener('click', async () => {
      disconnect();
      if (st.hosting) await stopHosting();
    });

    $('micBtn').addEventListener('click', () => {
      if (st.deafened) { st.deafened = false; st.muted = false; } else st.muted = !st.muted;
      pushState();
    });
    $('headBtn').addEventListener('click', () => {
      st.deafened = !st.deafened;
      pushState();
    });
    $('settingsBtn').addEventListener('click', () => {
      if (st.view === 'settings') setView(st.watching ? 'screen' : 'chat'); else setView('settings');
    });

    $('screenBtn').addEventListener('click', () => {
      if (!st.connected) return;
      if (st.sharing) sender.stop(); else openPicker();
    });
    $('pickerCancel').addEventListener('click', closePicker);
    $('pickerStart').addEventListener('click', startSharing);
    $('picker').addEventListener('keydown', (e) => { if (e.key === 'Escape') closePicker(); });
    document.querySelectorAll('input[name="quality"]').forEach((r) => r.addEventListener('change', () => {
      settings.screenQuality = r.value;
      saveSettings();
    }));
    $('screenCloseBtn').addEventListener('click', stopWatching);
    $('screenChatBtn').addEventListener('click', () => setView('chat'));
    $('screenFullBtn').addEventListener('click', () => {
      const stage = $('screenStage');
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      else stage.requestFullscreen().catch(() => {});
    });
    $('screenStage').addEventListener('dblclick', () => $('screenFullBtn').click());

    $('composer').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = $('msgInput');
      const text = input.value.trim();
      if (!text || !st.connected) return;
      const n = ++st.chatSeq;
      const url = settings.linkPreview ? firstUrl(text) : '';
      if (url) {
        st.pendingPreviews.set(n, url);
        if (st.pendingPreviews.size > 20) st.pendingPreviews.delete(st.pendingPreviews.keys().next().value);
      }
      send({ t: 'chat', text, n });
      input.value = '';
    });
    $('attachBtn').addEventListener('click', () => $('fileInput').click());
    $('fileInput').addEventListener('change', (e) => {
      if (st.connected && e.target.files.length) sendFiles(e.target.files);
      e.target.value = '';
    });
    document.addEventListener('dragover', (e) => e.preventDefault());
    document.addEventListener('drop', (e) => e.preventDefault());
    const msgBox = $('messages');
    msgBox.addEventListener('dragover', (e) => { if (st.connected) e.preventDefault(); });
    msgBox.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (st.connected && e.dataTransfer.files.length) sendFiles(e.dataTransfer.files);
    });

    $('nickInput').addEventListener('change', (e) => {
      settings.nick = e.target.value.trim().slice(0, 32);
      saveSettings();
      fillAvatar($('avatarPreview'), settings.avatar, myNick());
      pushProfile();
    });
    $('avatarBtn').addEventListener('click', () => $('avatarInput').click());
    $('avatarInput').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try {
        settings.avatar = await makeAvatar(file);
        saveSettings();
        fillAvatar($('avatarPreview'), settings.avatar, myNick());
        pushProfile();
        $('avatarError').hidden = true;
      } catch (err) {
        $('avatarError').textContent = err && err.message ? err.message : 'Не удалось загрузить картинку';
        $('avatarError').hidden = false;
      }
    });
    $('avatarClear').addEventListener('click', () => {
      settings.avatar = '';
      saveSettings();
      fillAvatar($('avatarPreview'), '', myNick());
      pushProfile();
    });

    document.querySelectorAll('input[name="mode"]').forEach((r) => r.addEventListener('change', () => {
      settings.mode = r.value;
      saveSettings();
      renderModeBoxes();
    }));
    $('pttKeyBtn').addEventListener('click', () => {
      if (!st.pttAvailable) return;
      st.capturingKey = !st.capturingKey;
      api.capturePtt(st.capturingKey);
      renderPttKey();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') cancelKeyCapture(); });

    $('vadRange').addEventListener('input', (e) => {
      settings.vadThreshold = Number(e.target.value);
      $('vadValue').textContent = `${settings.vadThreshold} дБ`;
      saveSettings();
    });
    $('nsToggle').addEventListener('change', (e) => {
      settings.noiseSuppression = e.target.checked;
      saveSettings();
      engine.updateInput({ noiseSuppression: settings.noiseSuppression }).catch(() => {});
    });
    $('inputSelect').addEventListener('change', (e) => {
      settings.inputId = e.target.value;
      saveSettings();
      engine.updateInput({ inputId: settings.inputId }).catch(() => addSystem('Не удалось открыть выбранный микрофон'));
    });
    $('outputSelect').addEventListener('change', (e) => {
      settings.outputId = e.target.value;
      saveSettings();
      engine.applyOutputDevice(settings.outputId);
    });
    $('inGainRange').addEventListener('input', (e) => {
      settings.inputGain = Number(e.target.value) / 100;
      $('inGainValue').textContent = `${e.target.value}%`;
      engine.setInputGain(settings.inputGain);
      saveSettings();
    });
    $('outVolRange').addEventListener('input', (e) => {
      settings.outputVolume = Number(e.target.value) / 100;
      $('outVolValue').textContent = `${e.target.value}%`;
      engine.setOutputVolume(settings.outputVolume);
      saveSettings();
    });
    $('previewToggle').addEventListener('change', (e) => {
      settings.linkPreview = e.target.checked;
      saveSettings();
    });
    $('overlayToggle').addEventListener('change', (e) => {
      settings.overlay = e.target.checked;
      saveSettings();
      renderOverlayPeers();
    });
    document.querySelectorAll('input[name="theme"]').forEach((r) => r.addEventListener('change', () => {
      settings.theme = r.value;
      document.documentElement.dataset.theme = settings.theme;
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
      saveSettings();
    }));
    $('portInput').addEventListener('change', (e) => {
      const p = Number(e.target.value);
      settings.port = p >= 1024 && p <= 65535 ? p : DEFAULT_PORT;
      e.target.value = String(settings.port);
      saveSettings();
    });
    $('passInput').addEventListener('change', (e) => {
      settings.password = e.target.value;
      saveSettings();
    });

    navigator.mediaDevices.addEventListener('devicechange', refreshDevices);

    $('updateCheckBtn').addEventListener('click', () => checkUpdates(false));
    $('updateInstallBtn').addEventListener('click', installUpdate);
    $('updateBannerBtn').addEventListener('click', () => {
      setView('settings').then(() => {
        const box = $('settingsBox');
        box.scrollTop = $('updateSection').offsetTop;
      });
    });
    api.onUpdateProgress((p) => {
      const ratio = p && p.total ? Math.min(1, p.received / p.total) : 0;
      $('updateBar').style.transform = `scaleX(${ratio})`;
      $('updateStatus').textContent = `Скачиваю ${Math.floor(ratio * 100)}%`;
    });

    api.onPttState((down) => { st.pttDown = !!down; });
    api.onPttCaptured((binding) => {
      st.capturingKey = false;
      settings.ptt = binding;
      saveSettings();
      api.setPtt(binding);
      renderPttKey();
    });
  }

  /**
   * Старт приложения.
   */
  async function init() {
    document.documentElement.dataset.theme = settings.theme;
    $('ipInput').value = settings.lastIp;
    bind();
    st.pttAvailable = await api.pttAvailable();
    const info = await api.appInfo();
    if (info) {
      $('versionText').textContent = info.version;
      $('footerVersion').textContent = info.version;
    }
    checkUpdates(true);
    if (settings.ptt) api.setPtt(settings.ptt);
    renderAll();
    setInterval(tickSpeaking, 100);
  }

  init();
})();
