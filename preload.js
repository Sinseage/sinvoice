/**
 * SINVoice — мост между окнами и главным процессом.
 *
 * @author Дмитрий Собенин (Sinseage)
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Подписка на событие главного процесса.
 * @param {string} channel Канал
 * @param {Function} cb Обработчик
 */
function on(channel, cb) {
  ipcRenderer.on(channel, (_e, data) => cb(data));
}

contextBridge.exposeInMainWorld('sinvoice', {
  minimize: () => ipcRenderer.send('win:minimize'),
  maximize: () => ipcRenderer.send('win:maximize'),
  close: () => ipcRenderer.send('win:close'),
  onMaximized: (cb) => on('win:maximized', cb),

  startServer: (opts) => ipcRenderer.invoke('server:start', opts),
  stopServer: () => ipcRenderer.invoke('server:stop'),

  linkPreview: (url) => ipcRenderer.invoke('link:preview', url),
  publicIp: () => ipcRenderer.invoke('net:publicIp'),
  appInfo: () => ipcRenderer.invoke('app:info'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  onUpdateProgress: (cb) => on('update:progress', cb),
  openReleases: () => ipcRenderer.send('app:openReleases'),

  screenSources: () => ipcRenderer.invoke('screen:sources'),
  screenSelect: (id) => ipcRenderer.send('screen:select', id),

  pttAvailable: () => ipcRenderer.invoke('ptt:available'),
  setPtt: (binding) => ipcRenderer.send('ptt:set', binding),
  capturePtt: (on) => ipcRenderer.send('ptt:capture', on),
  onPttState: (cb) => on('ptt:state', cb),
  onPttCaptured: (cb) => on('ptt:captured', cb),

  overlayPeers: (data) => ipcRenderer.send('overlay:peers', data),
  overlaySpeaking: (ids) => ipcRenderer.send('overlay:speaking', ids),
  onOverlayPeers: (cb) => on('overlay:peers', cb),
  onOverlaySpeaking: (cb) => on('overlay:speaking', cb),
});
