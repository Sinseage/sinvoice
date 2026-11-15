/**
 * SINVoice — обновление из релизов GitHub и определение внешнего IP.
 *
 * Обновление: берётся последний релиз репозитория, в нём ищется файл SINVoice-<версия>.exe,
 * он скачивается рядом с текущим exe, сверяется по размеру и SHA-256 (если GitHub его отдаёт),
 * после выхода программы подменяет старый файл и запускается.
 *
 * @author Дмитрий Собенин (Sinseage)
 */
'use strict';

const { net } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const REPO = 'Sinseage/sinvoice';
const RELEASES_URL = `https://github.com/${REPO}/releases`;
const API_LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;
const ASSET_RE = /^SINVoice-\d+\.\d+\.\d+\.exe$/;
const ALLOWED_HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);
const IP_SOURCES = ['https://api.ipify.org', 'https://ipv4.icanhazip.com', 'https://v4.ident.me'];
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/**
 * Запрос с таймаутом.
 * @param {string} url Адрес
 * @param {number} ms Таймаут
 * @param {object} [init] Параметры fetch
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(url, ms, init = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await net.fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Сравнивает версии вида 1.2.3.
 * @param {string} a Версия
 * @param {string} b Версия
 * @returns {number} >0 если a новее, <0 если старее, 0 если равны
 */
function compareVersions(a, b) {
  const pa = String(a).split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('-')[0].split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

class Updater {
  /**
   * @param {{version:string, logger:{info:Function, warn:Function, error:Function}}} opts Текущая версия и журнал
   */
  constructor(opts) {
    this.version = opts.version;
    this.log = opts.logger;
    this.exePath = process.env.PORTABLE_EXECUTABLE_FILE || '';
    this.latest = null;
    this.busy = false;
    this.publicIp = '';
    this.publicIpAt = 0;
  }

  /**
   * Можно ли обновиться на месте (запущен собранный portable exe).
   * @returns {boolean}
   */
  get canInstall() {
    return process.platform === 'win32' && !!this.exePath;
  }

  /**
   * Проверяет последний релиз.
   * @returns {Promise<{ok:boolean, current:string, latest?:string, available?:boolean, canInstall:boolean, page:string, error?:string}>}
   */
  async check() {
    const base = { current: this.version, canInstall: this.canInstall, page: RELEASES_URL };
    try {
      const res = await fetchWithTimeout(API_LATEST, 10000, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': `SINVoice/${this.version}` },
      });
      if (res.status === 404) return { ...base, ok: true, latest: this.version, available: false };
      if (!res.ok) return { ...base, ok: false, error: `GitHub ответил ${res.status}` };
      const rel = await res.json();
      const tag = String(rel.tag_name || '').replace(/^v/i, '');
      if (!/^\d+\.\d+\.\d+$/.test(tag)) return { ...base, ok: false, error: 'Неверный формат версии в релизе' };
      const asset = (Array.isArray(rel.assets) ? rel.assets : []).find((a) => ASSET_RE.test(String(a.name)));
      this.latest = asset ? {
        version: tag,
        name: asset.name,
        url: String(asset.browser_download_url || ''),
        size: Number(asset.size) || 0,
        sha256: /^sha256:[0-9a-f]{64}$/i.test(String(asset.digest || '')) ? String(asset.digest).slice(7).toLowerCase() : '',
        page: String(rel.html_url || RELEASES_URL),
      } : null;
      const available = !!asset && compareVersions(tag, this.version) > 0;
      return { ...base, ok: true, latest: tag, available, page: this.latest ? this.latest.page : RELEASES_URL };
    } catch (err) {
      this.log.warn(`Проверка обновлений: ${err && err.message}`);
      return { ...base, ok: false, error: 'Нет связи с GitHub' };
    }
  }

  /**
   * Скачивает новую версию и готовит замену exe после выхода.
   * @param {(received:number, total:number) => void} onProgress Ход загрузки
   * @returns {Promise<{ok:boolean, error?:string}>} При успехе программу нужно закрыть
   */
  async download(onProgress) {
    if (!this.canInstall) return { ok: false, error: 'Обновление работает только в собранном exe' };
    if (this.busy) return { ok: false, error: 'Обновление уже идёт' };
    if (!this.latest || compareVersions(this.latest.version, this.version) <= 0) return { ok: false, error: 'Нет новой версии' };
    const u = this.latest;
    let host = '';
    try { host = new URL(u.url).hostname; } catch (e) { host = ''; }
    if (!u.url.startsWith('https://') || !ALLOWED_HOSTS.has(host) || !u.size) return { ok: false, error: 'Недопустимый адрес файла обновления' };

    this.busy = true;
    const dir = path.dirname(this.exePath);
    const tmp = path.join(dir, `${u.name}.download`);
    try {
      const res = await fetchWithTimeout(u.url, 15 * 60 * 1000, { headers: { 'User-Agent': `SINVoice/${this.version}` } });
      if (!res.ok || !res.body) throw new Error(`загрузка: код ${res.status}`);
      const finalHost = new URL(res.url || u.url).hostname;
      if (!ALLOWED_HOSTS.has(finalHost)) throw new Error('загрузка перенаправлена на чужой адрес');
      const hash = crypto.createHash('sha256');
      const out = fs.createWriteStream(tmp);
      const reader = res.body.getReader();
      let received = 0;
      let lastReport = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        if (received > u.size) throw new Error('файл больше ожидаемого');
        hash.update(value);
        if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r));
        if (Date.now() - lastReport > 200) {
          lastReport = Date.now();
          onProgress(received, u.size);
        }
      }
      await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
      onProgress(received, u.size);
      if (received !== u.size) throw new Error('файл скачан не полностью');
      if (u.sha256 && hash.digest('hex') !== u.sha256) throw new Error('контрольная сумма не совпала');
      this.scheduleSwap(tmp, this.exePath);
      this.log.info(`Обновление ${u.version} скачано, замена после выхода`);
      return { ok: true };
    } catch (err) {
      this.log.error(`Обновление: ${err && err.message}`);
      try { fs.unlinkSync(tmp); } catch (e) { /* файла нет */ }
      const denied = err && (err.code === 'EPERM' || err.code === 'EACCES');
      return { ok: false, error: denied ? 'Нет прав на запись в папку программы' : `Не удалось обновить: ${err && err.message}` };
    } finally {
      this.busy = false;
    }
  }

  /**
   * Запускает скрытый сценарий PowerShell: ждёт выхода программы, подменяет exe и запускает его.
   * @param {string} newFile Скачанный файл
   * @param {string} oldFile Текущий exe
   */
  scheduleSwap(newFile, oldFile) {
    const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
    const script = [
      `$new = ${q(newFile)}`,
      `$old = ${q(oldFile)}`,
      'for ($i = 0; $i -lt 90; $i++) {',
      '  Start-Sleep -Milliseconds 1000',
      '  try {',
      '    Move-Item -LiteralPath $new -Destination $old -Force -ErrorAction Stop',
      '    Start-Process -FilePath $old',
      '    Remove-Item -LiteralPath $MyInvocation.MyCommand.Path -Force -ErrorAction SilentlyContinue',
      '    exit',
      '  } catch {}',
      '}',
      'Remove-Item -LiteralPath $new -Force -ErrorAction SilentlyContinue',
      'Start-Process -FilePath $old',
      'Remove-Item -LiteralPath $MyInvocation.MyCommand.Path -Force -ErrorAction SilentlyContinue',
    ].join('\r\n');
    const ps1 = path.join(os.tmpdir(), `sinvoice-update-${process.pid}.ps1`);
    fs.writeFileSync(ps1, '﻿' + script, 'utf8');
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', ps1], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  }

  /**
   * Внешний IPv4: спрашивает несколько сервисов по очереди, результат кешируется на 10 минут.
   * @returns {Promise<string>} Адрес или пустая строка
   */
  async getPublicIp() {
    if (this.publicIp && Date.now() - this.publicIpAt < 10 * 60 * 1000) return this.publicIp;
    for (const url of IP_SOURCES) {
      try {
        const res = await fetchWithTimeout(url, 5000);
        if (!res.ok) continue;
        const text = (await res.text()).trim().slice(0, 64);
        if (IPV4_RE.test(text)) {
          this.publicIp = text;
          this.publicIpAt = Date.now();
          return text;
        }
      } catch (e) {
        /* следующий сервис */
      }
    }
    return '';
  }
}

module.exports = { Updater, RELEASES_URL, compareVersions };
