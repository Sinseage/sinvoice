/**
 * SINVoice — главный процесс: окна, оверлей, сервер комнаты, глобальная клавиша рации.
 *
 * @author Дмитрий Собенин (Sinseage)
 */
'use strict';

const { app, BrowserWindow, ipcMain, screen, shell, session } = require('electron');
const path = require('path');
const os = require('os');
const { RoomServer } = require('./lib/server');
const { Logger } = require('./lib/logger');

const log = new Logger(app.getPath('userData'));

/** @type {BrowserWindow|null} */
let mainWin = null;
/** @type {BrowserWindow|null} */
let overlayWin = null;
/** @type {RoomServer|null} */
let server = null;

let hook = null;
let hookKeys = {};
let pttBinding = null;
let pttDown = false;
let captureMode = false;
let overlayTimer = 0;

const OVERLAY_WIDTH = 224;
const OVERLAY_ROW = 40;
const OVERLAY_PAD = 24;
const OVERLAY_MARGIN = 16;

process.on('uncaughtException', (err) => log.error(`Необработанная ошибка: ${err && err.stack ? err.stack : err}`));
process.on('unhandledRejection', (err) => log.error(`Необработанный отказ: ${err && err.stack ? err.stack : err}`));

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

app.on('second-instance', () => {
  if (mainWin) {
    if (mainWin.isMinimized()) mainWin.restore();
    mainWin.focus();
  }
});

/**
 * Общие настройки безопасности окон.
 * @returns {Electron.WebPreferences}
 */
function webPrefs() {
  return {
    preload: path.join(__dirname, 'preload.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    spellcheck: false,
    backgroundThrottling: false,
  };
}

/**
 * Запрещает переходы и новые окна; внешние ссылки открываются в браузере.
 * @param {BrowserWindow} win Окно
 */
function lockNavigation(win) {
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

/**
 * Пришло ли IPC-сообщение со страницы самой программы.
 * @param {Electron.IpcMainEvent|Electron.IpcMainInvokeEvent} e Событие
 * @returns {boolean}
 */
function trusted(e) {
  const own = (mainWin && e.sender === mainWin.webContents) || (overlayWin && e.sender === overlayWin.webContents);
  const frame = e.senderFrame;
  return !!own && !!frame && frame === e.sender.mainFrame && String(frame.url).startsWith('file:');
}

/**
 * Наше ли это окно.
 * @param {Electron.WebContents|null} wc Содержимое окна
 * @returns {boolean}
 */
function isOwn(wc) {
  return !!wc && ((mainWin && wc === mainWin.webContents) || (overlayWin && wc === overlayWin.webContents));
}

/**
 * Создаёт главное окно.
 */
function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 904,
    height: 640,
    minWidth: 720,
    minHeight: 520,
    frame: false,
    backgroundColor: '#17171c',
    icon: path.join(__dirname, 'src', 'assets', 'icon.png'),
    show: false,
    webPreferences: webPrefs(),
  });
  mainWin.setMenu(null);
  lockNavigation(mainWin);
  mainWin.loadFile(path.join(__dirname, 'src', 'index.html'));
  mainWin.once('ready-to-show', () => mainWin.show());
  mainWin.webContents.on('render-process-gone', (_e, d) => log.error(`Окно упало: ${d.reason}`));
  mainWin.on('closed', () => {
    mainWin = null;
    app.quit();
  });
}

/**
 * Создаёт прозрачное окно оверлея: слева сверху, поверх всех окон, не перехватывает мышь.
 */
function createOverlayWindow() {
  const { x, y } = screen.getPrimaryDisplay().workArea;
  overlayWin = new BrowserWindow({
    x: x + OVERLAY_MARGIN,
    y: y + OVERLAY_MARGIN,
    width: OVERLAY_WIDTH,
    height: OVERLAY_ROW + OVERLAY_PAD,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    webPreferences: webPrefs(),
  });
  lockNavigation(overlayWin);
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWin.setIgnoreMouseEvents(true);
  overlayWin.loadFile(path.join(__dirname, 'src', 'overlay.html'));
}

/**
 * Показывает или прячет оверлей. Пока он виден, раз в 2 секунды поднимает его наверх:
 * окна игр в режиме «без рамки» могут его перекрыть.
 * @param {boolean} visible Показать
 */
function setOverlayVisible(visible) {
  if (!overlayWin) return;
  if (visible && !overlayWin.isVisible()) {
    overlayWin.showInactive();
    overlayWin.setAlwaysOnTop(true, 'screen-saver');
    clearInterval(overlayTimer);
    overlayTimer = setInterval(() => {
      if (overlayWin && overlayWin.isVisible()) overlayWin.moveTop();
    }, 2000);
  } else if (!visible && overlayWin.isVisible()) {
    overlayWin.hide();
    clearInterval(overlayTimer);
  }
}

/**
 * Подключает глобальный перехват клавиатуры и мыши для рации; работает и в играх.
 */
function initHook() {
  try {
    const mod = require('uiohook-napi');
    hook = mod.uIOhook;
    hookKeys = {};
    for (const [name, code] of Object.entries(mod.UiohookKey)) {
      if (!(code in hookKeys)) hookKeys[code] = name;
    }
    hook.on('keydown', (e) => onInput('key', e.keycode, true));
    hook.on('keyup', (e) => onInput('key', e.keycode, false));
    hook.on('mousedown', (e) => onInput('mouse', e.button, true));
    hook.on('mouseup', (e) => onInput('mouse', e.button, false));
    hook.start();
  } catch (err) {
    hook = null;
    log.warn(`Глобальная клавиша недоступна: ${err && err.message}`);
  }
}

/**
 * Нажатие или отпускание: для рации и для назначения клавиши.
 * @param {'key'|'mouse'} type Устройство
 * @param {number} code Код клавиши или номер кнопки мыши
 * @param {boolean} down Нажата ли
 */
function onInput(type, code, down) {
  if (captureMode && down) {
    if (type === 'mouse' && code === 1) return;
    captureMode = false;
    const name = type === 'mouse' ? `Мышь ${code}` : (hookKeys[code] || `Код ${code}`);
    pttBinding = { type, code, name };
    if (mainWin) mainWin.webContents.send('ptt:captured', pttBinding);
    return;
  }
  if (!pttBinding || pttBinding.type !== type || pttBinding.code !== code || pttDown === down) return;
  pttDown = down;
  if (mainWin) mainWin.webContents.send('ptt:state', down);
}

/**
 * Подгоняет высоту оверлея под число участников.
 * @param {number} count Участников
 */
function resizeOverlay(count) {
  if (!overlayWin) return;
  const { x, y } = screen.getPrimaryDisplay().workArea;
  overlayWin.setBounds({
    x: x + OVERLAY_MARGIN,
    y: y + OVERLAY_MARGIN,
    width: OVERLAY_WIDTH,
    height: Math.max(1, count) * OVERLAY_ROW + OVERLAY_PAD,
  });
}

/**
 * Локальные IPv4-адреса машины — подсказка для настройки проброса порта.
 * @returns {string[]}
 */
function localAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return out;
}

/**
 * Регистрирует обработчик IPC, который принимает сообщения только от страниц программы.
 * @param {string} channel Канал
 * @param {Function} fn Обработчик (data)
 */
function onIpc(channel, fn) {
  ipcMain.on(channel, (e, data) => {
    if (!trusted(e)) return;
    try { fn(data); } catch (err) { log.error(`IPC ${channel}: ${err && err.message}`); }
  });
}

/**
 * Регистрирует обработчик IPC с ответом.
 * @param {string} channel Канал
 * @param {Function} fn Асинхронный обработчик (data)
 */
function handleIpc(channel, fn) {
  ipcMain.handle(channel, async (e, data) => {
    if (!trusted(e)) return null;
    try { return await fn(data); } catch (err) {
      log.error(`IPC ${channel}: ${err && err.message}`);
      return { ok: false, error: 'Внутренняя ошибка' };
    }
  });
}

onIpc('win:minimize', () => mainWin && mainWin.minimize());
onIpc('win:maximize', () => {
  if (!mainWin) return;
  if (mainWin.isMaximized()) mainWin.unmaximize(); else mainWin.maximize();
});
onIpc('win:close', () => mainWin && mainWin.close());

handleIpc('server:start', async (opts) => {
  if (server) return { ok: true, port: server.port, addresses: localAddresses() };
  const port = Number(opts && opts.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return { ok: false, error: 'Порт должен быть от 1024 до 65535' };
  const password = typeof (opts && opts.password) === 'string' ? opts.password.slice(0, 128) : '';
  const s = new RoomServer({ port, password, logger: log });
  try {
    await s.start();
    server = s;
    return { ok: true, port, addresses: localAddresses() };
  } catch (err) {
    log.error(`Не удалось запустить сервер: ${err && err.message}`);
    if (err && err.code === 'EADDRINUSE') return { ok: false, error: `Порт ${port} уже занят` };
    if (err && err.code === 'EACCES') return { ok: false, error: `Нет доступа к порту ${port}` };
    return { ok: false, error: 'Не удалось запустить сервер' };
  }
});

handleIpc('server:stop', async () => {
  if (server) {
    const s = server;
    server = null;
    await s.stop();
  }
  return { ok: true };
});

handleIpc('ptt:available', async () => !!hook);
onIpc('ptt:set', (b) => {
  const valid = b && (b.type === 'key' || b.type === 'mouse') && Number.isInteger(b.code);
  pttBinding = valid ? { type: b.type, code: b.code, name: String(b.name || '').slice(0, 32) } : null;
  pttDown = false;
});
onIpc('ptt:capture', (on) => { captureMode = !!on; });

onIpc('overlay:peers', (data) => {
  if (!overlayWin) return;
  const peers = Array.isArray(data && data.peers) ? data.peers.slice(0, 16) : [];
  resizeOverlay(peers.length);
  overlayWin.webContents.send('overlay:peers', peers);
  setOverlayVisible(!!(data && data.visible) && peers.length > 0);
});

onIpc('overlay:speaking', (ids) => {
  if (overlayWin && Array.isArray(ids)) overlayWin.webContents.send('overlay:speaking', ids.filter(Number.isInteger));
});

app.whenReady().then(() => {
  const allowed = new Set(['media', 'speaker-selection']);
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    cb(isOwn(wc) && allowed.has(permission));
  });
  session.defaultSession.setPermissionCheckHandler((wc, permission) => allowed.has(permission) && (!wc || isOwn(wc)));
  createMainWindow();
  createOverlayWindow();
  initHook();
});

app.on('web-contents-created', (_e, wc) => {
  wc.on('will-attach-webview', (e) => e.preventDefault());
});

app.on('before-quit', () => {
  if (hook) {
    try { hook.stop(); } catch (e) { /* уже остановлен */ }
  }
  if (server) server.stop();
});

app.on('window-all-closed', () => app.quit());
