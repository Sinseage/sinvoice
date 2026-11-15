/**
 * SINVoice — журнал ошибок и событий безопасности.
 *
 * Пишет в файл sinvoice.log в папке данных программы; при превышении 1 МБ
 * старый журнал переименовывается в sinvoice.old.log. Ошибки записи не мешают работе.
 *
 * @author Дмитрий Собенин (Sinseage)
 */
'use strict';

const fs = require('fs');
const path = require('path');

const MAX_SIZE = 1024 * 1024;

class Logger {
  /**
   * @param {string} dir Папка для журнала
   */
  constructor(dir) {
    this.file = path.join(dir, 'sinvoice.log');
    this.old = path.join(dir, 'sinvoice.old.log');
  }

  /**
   * Записывает строку в журнал.
   * @param {'info'|'warn'|'error'} level Уровень
   * @param {string} message Текст
   */
  write(level, message) {
    const line = `${new Date().toISOString()} [SINVoice] ${level.toUpperCase()} ${String(message).replace(/[\r\n]+/g, ' ')}\n`;
    try {
      if (fs.existsSync(this.file) && fs.statSync(this.file).size > MAX_SIZE) {
        fs.renameSync(this.file, this.old);
      }
      fs.appendFileSync(this.file, line, 'utf8');
    } catch (e) {
      /* журнал недоступен — работаем без него */
    }
  }

  /** @param {string} m Текст */
  info(m) { this.write('info', m); }

  /** @param {string} m Текст */
  warn(m) { this.write('warn', m); }

  /** @param {string} m Текст */
  error(m) { this.write('error', m); }
}

module.exports = { Logger };
