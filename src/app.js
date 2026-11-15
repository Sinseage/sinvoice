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
  const $ = (id) => document.getElementById(id);

  const STORE_KEY = 'sinvoice.settings';
  const DEFAULT_PORT = 47800;
  const VAD_HOLD_MS = 350;
  const SPEAK_HOLD_MS = 250;
  const FILE_CHUNK = 64 * 1024;
  const FILE_WINDOW = 16;
  const MAX_FILE = 2 * 1024 * 1024 * 1024;
  const T_AUDIO = 1;
  const T_FILE = 2;

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
    level: 0,
  };

  const engine = new window.AudioEngine(onMicFrame);

  /* ---------- Настройки ---------- */

  /**
   * Загружает настройки из локального хранилища.
   * @returns {object}
   */
  function loadSettings() {
    try {
      return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORE_KEY) || '{}') };
    } catch (e) {
      return { ...DEFAULTS };
    }
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
    if (cls) svg.classList.add(cls);
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
    if (avatar) {
      const img = el('img');
      img.src = avatar;
      img.alt = '';
      slot.appendChild(img);
      slot.style.background = 'transparent';
    } else {
      slot.textContent = (nick || '?').trim().charAt(0).toUpperCase() || '?';
      slot.style.background = hue(nick || '?');
    }
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
        for (const p of m.peers) st.peers.set(p.id, { ...p, lastAudio: 0 });
        startPing();
        if (!engine.running) startAudio();
        addSystem('Вы вошли в звонок');
        renderAll();
        break;
      case 'error':
        showError(m.text || 'Ошибка сервера');
        st.leaving = true;
        break;
      case 'join':
        st.peers.set(m.peer.id, { ...m.peer, lastAudio: 0 });
        addSystem(`${m.peer.nick} подключился`);
        renderAll();
        break;
      case 'leave': {
        const p = st.peers.get(m.id);
        st.peers.delete(m.id);
        engine.removePeer(m.id);
        if (p) addSystem(`${p.nick} вышел`);
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
        if (p) { p.nick = m.peer.nick; p.avatar = m.peer.avatar; renderPeers(); }
        break;
      }
      case 'pong':
        st.rtt = Math.round(performance.now() - m.ts);
        renderStatus();
        break;
      case 'chat':
        addChat(m.id, m.text, m.ts);
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
    const addrs = (res.addresses || []).join(', ');
    const info = $('hostInfo');
    info.textContent = '';
    info.append(el('b', '', 'Сервер запущен'), document.createTextNode(` · порт ${res.port}`));
    if (addrs) info.append(el('br'), document.createTextNode(`Локальные адреса: ${addrs}`));
    renderAll();
    connect('127.0.0.1', res.port);
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
    const e = el('div', 'empty', 'Здесь появятся сообщения и файлы этого звонка');
    e.id = 'chatEmpty';
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
    if (atBottom) box.scrollTop = box.scrollHeight;
  }

  /**
   * Служебная строка в ленте.
   * @param {string} text Текст
   */
  function addSystem(text) {
    pushMessage(el('div', 'msg msg--sys', text));
  }

  /**
   * Каркас сообщения от участника.
   * @param {number} id Id автора
   * @param {number} ts Время
   * @returns {{root:HTMLElement, body:HTMLElement}}
   */
  function messageShell(id, ts) {
    const p = st.peers.get(id) || { nick: '???', avatar: '' };
    const root = el('div', 'msg');
    const av = el('div', 'avatar-slot');
    fillAvatar(av, p.avatar, p.nick);
    const body = el('div', 'msg__body');
    const head = el('div', 'msg__head');
    head.append(el('span', 'msg__nick', p.nick), el('span', 'msg__time', fmtTime(ts)));
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
  function addChat(id, text, ts) {
    const { root, body } = messageShell(id, ts);
    body.appendChild(el('div', 'msg__text', text));
    pushMessage(root);
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
    const card = el('div', 'filecard');
    const ic = el('div', 'filecard__icon');
    ic.appendChild(icon('file'));
    const info = el('div', 'filecard__info');
    const nm = el('div', 'filecard__name', name);
    nm.title = name;
    const state = el('div', 'filecard__state');
    const prog = el('div', 'progress');
    const bar = el('i');
    prog.appendChild(bar);
    info.append(nm, state, prog);
    const act = el('button', 'filecard__act');
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
    ui.bar.style.width = `${pct}%`;
    const set = (text, showProg, act) => {
      ui.state.textContent = text;
      ui.prog.hidden = !showProg;
      ui.act.hidden = !act;
      if (act) {
        ui.act.textContent = '';
        ui.act.appendChild(icon(act));
        ui.act.className = act === 'down' ? 'filecard__act filecard__act--save' : 'filecard__act';
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
    const key = `${m.id}:${m.fid}`;
    const f = { from: m.id, fid: m.fid, name: m.name, size: m.size, done: 0, chunks: [], state: 'recv', url: '', ui: null };
    st.incoming.set(key, f);
    f.ui = makeFileCard(key, m.id, m.name);
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
    f.chunks.push(data);
    f.done += data.length;
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
    host.className = st.hosting ? 'btn btn--danger btn--block' : 'btn btn--primary btn--block';
    host.disabled = !st.hosting && (st.connected || st.connecting);
    $('hostInfo').hidden = !st.hosting;

    const conn = $('connectBtn');
    const inCall = st.connected || st.connecting;
    conn.textContent = st.connecting ? 'Подключение…' : (st.connected ? 'Отключиться' : 'Подключиться');
    conn.className = st.connected ? 'btn btn--ghost btn--block' : 'btn btn--primary btn--block';
    conn.disabled = st.hosting || st.connecting;
    $('ipInput').disabled = inCall || st.hosting;
    $('composer').classList.toggle('composer--disabled', !st.connected);
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
      const li = el('li', 'peer');
      li.dataset.id = String(p.id);
      if (p.id === st.myId) li.classList.add('peer--me');
      const av = el('div', 'avatar-slot');
      fillAvatar(av, p.avatar, p.nick);
      const name = el('span', 'peer__name', p.nick);
      const icons = el('span', 'peer__icons');
      const muted = p.id === st.myId ? (st.muted || st.deafened) : p.muted;
      const deaf = p.id === st.myId ? st.deafened : p.deafened;
      if (deaf) icons.appendChild(icon('head-off', 'off'));
      icons.appendChild(muted ? icon('mic-off', 'off') : icon('mic'));
      const eq = el('span', 'eq');
      eq.append(el('i'), el('i'), el('i'), el('i'));
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
    mic.className = micOff ? 'ctl ctl--off' : 'ctl ctl--accent';
    mic.textContent = '';
    mic.appendChild(icon(micOff ? 'mic-off' : 'mic'));
    mic.title = micOff ? 'Включить микрофон' : 'Выключить микрофон';

    const head = $('headBtn');
    head.className = st.deafened ? 'ctl ctl--off' : 'ctl';
    head.textContent = '';
    head.appendChild(icon(st.deafened ? 'head-off' : 'head'));
    head.title = st.deafened ? 'Включить звук' : 'Выключить звук';

    const gear = $('settingsBtn');
    gear.classList.toggle('ctl--active', st.view === 'settings');
    gear.title = st.view === 'settings' ? 'Вернуться в чат' : 'Настройки';
    gear.textContent = '';
    gear.appendChild(icon(st.view === 'settings' ? 'chat' : 'gear'));

    $('hangupBtn').disabled = !(st.connected || st.connecting);
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
        li.classList.toggle('speaking', ids.includes(Number(li.dataset.id)));
      }
      api.overlaySpeaking(ids);
    }
    if (st.view === 'settings') {
      const pct = Math.max(0, Math.min(100, ((st.level + 80) / 70) * 100));
      $('meterBar').style.setProperty('--lvl', engine.running ? `${pct}%` : '0%');
    }
  }

  /**
   * Передаёт список участников в оверлей.
   */
  function renderOverlayPeers() {
    api.overlayPeers({
      visible: settings.overlay && st.connected,
      peers: sortedPeers().map((p) => ({
        id: p.id,
        nick: p.nick,
        avatar: p.avatar,
        muted: p.id === st.myId ? (st.muted || st.deafened) : p.muted,
        color: hue(p.nick || '?'),
      })),
    });
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
    b.classList.toggle('key--wait', st.capturingKey);
    b.textContent = st.capturingKey ? 'Нажмите клавишу…' : (settings.ptt ? settings.ptt.name : 'Не назначена');
    $('pttHint').textContent = st.pttAvailable ? (st.capturingKey ? 'Esc — отмена' : '') : 'Глобальная клавиша недоступна';
  }

  /**
   * Затемняет параметры неактивного режима.
   */
  function renderModeBoxes() {
    $('pttBox').classList.toggle('sub--off', settings.mode !== 'ptt');
    $('vadBox').classList.toggle('sub--off', settings.mode !== 'vad');
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
   * Уменьшает картинку до квадрата 128×128.
   * @param {File} file Изображение
   * @returns {Promise<string>} Data URL
   */
  function makeAvatar(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const size = 128;
        const c = document.createElement('canvas');
        c.width = size;
        c.height = size;
        const s = Math.min(img.width, img.height);
        c.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
        URL.revokeObjectURL(url);
        resolve(c.toDataURL('image/png'));
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('bad image')); };
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
    $('settingsBtn').addEventListener('click', () => setView(st.view === 'settings' ? 'chat' : 'settings'));

    $('composer').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = $('msgInput');
      const text = input.value.trim();
      if (!text || !st.connected) return;
      send({ t: 'chat', text });
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
      } catch (err) { /* не картинка — игнорируем */ }
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
    $('overlayToggle').addEventListener('change', (e) => {
      settings.overlay = e.target.checked;
      saveSettings();
      renderOverlayPeers();
    });
    document.querySelectorAll('input[name="theme"]').forEach((r) => r.addEventListener('change', () => {
      settings.theme = r.value;
      document.documentElement.dataset.theme = settings.theme;
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
    if (settings.ptt) api.setPtt(settings.ptt);
    renderAll();
    setInterval(tickSpeaking, 100);
  }

  init();
})();
