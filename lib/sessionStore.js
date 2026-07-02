/* ============================================================
   Постоянное хранилище сессий (вход в кухню/админку).
   По умолчанию express-session хранит сессии в памяти процесса —
   при любом перезапуске сервера (деплой, краш, `node --watch` в dev-режиме)
   все сотрудники разом вылетают из панели.
   Этот файл хранит сессии в data/sessions.json, поэтому они переживают
   перезапуск процесса (как и SESSION_SECRET — см. server.js).
   ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const session = require('express-session');
const { DATA_DIR } = require('./paths');

const FILE = path.join(DATA_DIR, 'sessions.json');

class FileSessionStore extends session.Store {
  constructor() {
    super();
    this.sessions = {};
    this._load();
    // раз в час подчищаем просроченные сессии из памяти/файла
    this._gc = setInterval(() => this._sweep(), 60 * 60 * 1000);
    if (this._gc.unref) this._gc.unref();
  }

  _load() {
    try {
      if (fs.existsSync(FILE)) {
        const raw = fs.readFileSync(FILE, 'utf8').trim();
        this.sessions = raw ? JSON.parse(raw) : {};
      }
    } catch (e) {
      console.error('sessionStore: не удалось прочитать sessions.json —', e.message);
      this.sessions = {};
    }
    this._sweep(false);
  }

  _sweep(save) {
    const now = Date.now();
    let changed = false;
    for (const sid of Object.keys(this.sessions)) {
      const entry = this.sessions[sid];
      if (entry && entry.expires && entry.expires < now) {
        delete this.sessions[sid];
        changed = true;
      }
    }
    if (changed && save !== false) this._save();
  }

  _save() {
    try {
      if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.sessions), 'utf8');
      fs.renameSync(tmp, FILE);
    } catch (e) {
      console.error('sessionStore: не удалось сохранить sessions.json —', e.message);
    }
  }

  get(sid, cb) {
    const entry = this.sessions[sid];
    if (!entry) return cb(null, null);
    if (entry.expires && entry.expires < Date.now()) {
      delete this.sessions[sid];
      return cb(null, null);
    }
    cb(null, entry.data);
  }

  set(sid, sessionData, cb) {
    const maxAge = sessionData && sessionData.cookie && sessionData.cookie.maxAge;
    this.sessions[sid] = { data: sessionData, expires: maxAge ? Date.now() + maxAge : null };
    this._save();
    if (cb) cb();
  }

  destroy(sid, cb) {
    delete this.sessions[sid];
    this._save();
    if (cb) cb();
  }

  touch(sid, sessionData, cb) {
    const entry = this.sessions[sid];
    if (entry) {
      const maxAge = sessionData && sessionData.cookie && sessionData.cookie.maxAge;
      entry.expires = maxAge ? Date.now() + maxAge : null;
      this._save();
    }
    if (cb) cb();
  }

  all(cb) {
    cb(null, Object.keys(this.sessions).map((sid) => this.sessions[sid].data));
  }

  length(cb) {
    cb(null, Object.keys(this.sessions).length);
  }

  clear(cb) {
    this.sessions = {};
    this._save();
    if (cb) cb();
  }
}

module.exports = FileSessionStore;
