/**
 * SINVoice — главный процесс: окна, оверлей, сервер комнаты, глобальная клавиша рации.
 *
 * @author Дмитрий Собенин (Sinseage)
 */
'use strict';

const { app, BrowserWindow, ipcMain, screen, shell, session } = require('electron');
const path = require('path');
const os = require('os');
const { RoomServer } = require('./server');

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

const OVERLAY_WIDTH = 220;
const OVERLAY_ROW = 36;
const OVERLAY_PAD = 12;

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
 * Создаёт главное окно.
 */
function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 900,
    height: 640,
    minWidth: 760,
    minHeight: 520,
    frame: false,
    backgroundColor: '#17171c',
    icon: path.join(__dirname, 'src', 'assets', 'icon.png'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  mainWin.setMenu(null);
  mainWin.loadFile(path.join(__dirname, 'src', 'index.html'));
  mainWin.once('ready-to-show', () => mainWin.show());
  mainWin.on('maximize', () => mainWin.webContents.send('win:maximized', true));
  mainWin.on('unmaximize', () => mainWin.webContents.send('win:maximized', false));
  mainWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWin.webContents.on('will-navigate', (e) => e.preventDefault());
  mainWin.on('closed', () => {
    mainWin = null;
    app.quit();
  });
}

/**
 * Создаёт прозрачное окно оверлея (слева сверху, поверх всех окон, не перехватывает мышь).
 */
function createOverlayWindow() {
  const { x, y } = screen.getPrimaryDisplay().workArea;
  overlayWin = new BrowserWindow({
    x: x + 16,
    y: y + 16,
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
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWin.setIgnoreMouseEvents(true);
  overlayWin.loadFile(path.join(__dirname, 'src', 'overlay.html'));
  // Полноэкранные окна игр могут перекрыть оверлей — периодически поднимаем его обратно.
  setInterval(() => {
    if (overlayWin && overlayWin.isVisible()) overlayWin.moveTop();
  }, 2000);
}

/**
 * Подключает глобальный перехват клавиатуры и мыши для рации.
 * Работает и когда окно игры активно.
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
  }
}

/**
 * Обработка нажатия/отпускания для рации и для назначения клавиши.
 * @param {'key'|'mouse'} type Тип устройства
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
  if (!pttBinding || pttBinding.type !== type || pttBinding.code !== code) return;
  if (pttDown === down) return;
  pttDown = down;
  if (mainWin) mainWin.webContents.send('ptt:state', down);
}

/**
 * Пересчитывает высоту оверлея под число участников.
 * @param {number} count Участников
 */
function resizeOverlay(count) {
  if (!overlayWin) return;
  const h = Math.max(1, count) * OVERLAY_ROW + OVERLAY_PAD;
  const { x, y } = screen.getPrimaryDisplay().workArea;
  overlayWin.setBounds({ x: x + 16, y: y + 16, width: OVERLAY_WIDTH, height: h });
}

/**
 * Возвращает локальные IPv4-адреса машины.
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

ipcMain.on('win:minimize', () => mainWin && mainWin.minimize());
ipcMain.on('win:maximize', () => {
  if (!mainWin) return;
  if (mainWin.isMaximized()) mainWin.unmaximize(); else mainWin.maximize();
});
ipcMain.on('win:close', () => mainWin && mainWin.close());

ipcMain.handle('server:start', async (_e, opts) => {
  if (server) return { ok: true, port: server.port };
  const port = Number(opts && opts.port) || 47800;
  const s = new RoomServer({ port, password: (opts && opts.password) || '' });
  try {
    await s.start();
    server = s;
    return { ok: true, port, addresses: localAddresses() };
  } catch (err) {
    const busy = err && err.code === 'EADDRINUSE';
    return { ok: false, error: busy ? `Порт ${port} уже занят` : String(err && err.message || err) };
  }
});

ipcMain.handle('server:stop', async () => {
  if (server) {
    await server.stop();
    server = null;
  }
  return { ok: true };
});

ipcMain.handle('ptt:available', () => !!hook);
ipcMain.on('ptt:set', (_e, binding) => {
  pttBinding = binding && typeof binding.code === 'number' ? binding : null;
  pttDown = false;
});
ipcMain.on('ptt:capture', (_e, on) => { captureMode = !!on; });

ipcMain.on('overlay:peers', (_e, data) => {
  if (!overlayWin) return;
  const peers = Array.isArray(data && data.peers) ? data.peers : [];
  const visible = !!(data && data.visible) && peers.length > 0;
  resizeOverlay(peers.length);
  overlayWin.webContents.send('overlay:peers', peers);
  if (visible && !overlayWin.isVisible()) {
    overlayWin.showInactive();
    overlayWin.setAlwaysOnTop(true, 'screen-saver');
  } else if (!visible && overlayWin.isVisible()) {
    overlayWin.hide();
  }
});

ipcMain.on('overlay:speaking', (_e, ids) => {
  if (overlayWin) overlayWin.webContents.send('overlay:speaking', ids);
});

app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(permission === 'media' || permission === 'speaker-selection');
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => {
    return permission === 'media' || permission === 'speaker-selection';
  });
  createMainWindow();
  createOverlayWindow();
  initHook();
});

app.on('before-quit', () => {
  if (hook) {
    try { hook.stop(); } catch (e) { /* уже остановлен */ }
  }
  if (server) server.stop();
});

app.on('window-all-closed', () => app.quit());
